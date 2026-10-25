# -*- coding: utf-8 -*-
"""三类候选方案生成（规划 §5.2 / §8.2 B02）。

三套策略是三种明确的目标，不是同一算法换文案：
- A 人人有期待 balanced：先保证每人「必须要」，再用剩余预算补「最好有」。
- B 整单更划算 value    ：硬约束不动，逐人取可满足「必须要」的最低价搭法，并试算优惠券。
- C 一起尝点新 explore  ：沿用 A 的心愿骨架，用余量加入新品/限时项，并说明预算变化。

刻意不做的事：不编造价格（一律走官方核价）、不用不可解释的评分、
不在结果相同时制造虚假差异（收敛就如实标注）。
"""
from __future__ import annotations

from .allocate import build_allocation, check_budget, per_head_cents
from .explain import (STRATEGY_META, build_tradeoffs, build_wish_results)
from .rules import (fmt_yuan, item_kind, mark_flags, resolve_wishes, violates)

DETAIL_BUDGET = 45          # 单次方案生成最多预取多少款餐品的组成详情（控制耗时）
MAX_QUANTITY = 99           # 单条餐品数量上限：负数/超大值会污染核价与分账
MAX_ROWS = 60               # 手动调整的条目上限，避免一次请求打爆官方核价
MAX_EXTRAS_PER_PERSON = 1   # A 方案每人最多补 1 件配餐，避免堆量
MAX_EXPLORE_ITEMS = 2       # C 方案最多加 2 件探索项


# ---------------------------------------------------------------- 候选池

def candidate_codes(party: dict, items: list[dict], resolution: dict) -> list[str]:
    """挑出需要取详情的餐品，控制网络耗时。

    优先级：与心愿匹配到的 → 便宜的主餐/配餐 → 新品。
    详情的作用是拿到套餐组成，用于忌口校验（例如三件套里是否含「麦辣」）。
    """
    by_code = {it["productCode"]: it for it in items}
    wanted: list[str] = []

    def push(code):
        if code in by_code and code not in wanted:
            wanted.append(code)

    for mid, res in resolution.items():
        for group in ("must", "nice"):
            for entry in res.get(group) or []:
                for m in entry.get("matches") or []:
                    push(m["productCode"])

    mains = sorted((it for it in items if item_kind(it) == "main"),
                   key=lambda x: x.get("priceCents") or 0)
    sides = sorted((it for it in items if item_kind(it) in ("side", "drink")),
                   key=lambda x: x.get("priceCents") or 0)
    for it in mains[:24]:
        push(it["productCode"])
    for it in sides[:10]:
        push(it["productCode"])
    for it in [x for x in items if x.get("novelty")][:8]:
        push(it["productCode"])

    return wanted[:DETAIL_BUDGET]


def attach_components(items: list[dict], details: dict[str, dict]) -> int:
    """把详情里的套餐组成写回菜单项，返回缺失详情的数量。"""
    missing = 0
    for it in items:
        detail = details.get(it["productCode"]) or {}
        comps = detail.get("components") or []
        if comps:
            it["components"] = comps
            it["hasDetail"] = True
        else:
            it.setdefault("components", [])
            it["hasDetail"] = bool(detail.get("ok"))
            if not it["hasDetail"]:
                missing += 1
    return missing


# ---------------------------------------------------------------- 单品挑选

def _cheapest(candidates: list[dict]) -> dict | None:
    return min(candidates, key=lambda x: (x.get("priceCents") or 0, x["productCode"])) if candidates else None


def _matched_codes(entries: list[dict]) -> set[str]:
    codes = set()
    for e in entries or []:
        for m in e.get("matches") or []:
            codes.add(m["productCode"])
    return codes


def _pick_primary(member: dict, res: dict, eligible: list[dict], strategy: str) -> tuple[dict | None, dict]:
    """为一位成员挑「主力单品」。返回 (item, 说明)。"""
    by_code = {it["productCode"]: it for it in eligible}
    must_codes = _matched_codes(res.get("must"))
    nice_codes = _matched_codes(res.get("nice"))

    must_items = [by_code[c] for c in must_codes if c in by_code]
    info = {"mode": None, "wish": None}

    if must_items:
        # 同一档匹配里优先「单品」再考虑套餐：用户说「必须麦辣鸡腿堡」时，
        # 给他一个四件套虽然也算满足，但多花的钱不是他要的。
        if strategy == "value":
            pick = sorted(must_items, key=lambda x: (bool(x.get("combo")), x.get("priceCents") or 0))[0]
            info.update(mode="cheapest-must")
        else:
            def score(it):
                bonus = 1 if it["productCode"] in nice_codes else 0
                return (-bonus, bool(it.get("combo")), it.get("priceCents") or 0)
            pick = sorted(must_items, key=score)[0]
            info.update(mode="best-wish")
        for entry in res.get("must") or []:
            if pick["productCode"] in {m["productCode"] for m in entry.get("matches") or []}:
                info["wish"] = entry["wish"]
                break
        return pick, info

    # 没有匹配到「必须要」：不擅自替用户假设口味，只按最省/最常规给一件主餐
    mains = [it for it in eligible if item_kind(it) == "main"]
    pick = _cheapest(mains) or _cheapest(eligible)
    info.update(mode="fallback-main")
    return pick, info


def _pick_extra(member: dict, res: dict, eligible: list[dict], used: set[str]) -> dict | None:
    """为 A 方案补一件配餐：只补能对上「最好有」的，不随机加量。"""
    by_code = {it["productCode"]: it for it in eligible}
    nice_codes = _matched_codes(res.get("nice"))
    candidates = [by_code[c] for c in nice_codes if c in by_code and c not in used]
    pick = _cheapest(candidates)
    if pick:
        for entry in res.get("nice") or []:
            if pick["productCode"] in {m["productCode"] for m in entry.get("matches") or []}:
                pick = dict(pick)
                pick["_forWish"] = entry["wish"]
                break
    return pick


# ---------------------------------------------------------------- 组单

def _entry(item: dict, assignee_id: str | None, quantity: int = 1) -> dict:
    return {
        "productCode": item["productCode"],
        "name": item.get("name"),
        "quantity": quantity,
        "unitPriceCents": item.get("priceCents") or 0,
        "assigneeId": assignee_id,
        "shared": assignee_id is None,
        "novelty": bool(item.get("novelty")),
        "components": list(item.get("components") or []),
        "tags": list(item.get("tags") or []),
    }


def _merge(entries: list[dict]) -> list[dict]:
    """同商品同归属合并数量，避免清单里出现两行一样的餐品。"""
    merged: dict[tuple, dict] = {}
    order: list[tuple] = []
    for e in entries:
        key = (e["productCode"], e.get("assigneeId"))
        if key in merged:
            merged[key]["quantity"] += e["quantity"]
        else:
            merged[key] = dict(e)
            order.append(key)
    return [merged[k] for k in order]


def _estimate_total(entries: list[dict]) -> int:
    return sum(int(e.get("unitPriceCents") or 0) * int(e.get("quantity") or 1) for e in entries)


def _member_eligible(items: list[dict], never_map: dict, mid: str) -> list[dict]:
    """某位成员自己可以吃的餐品。

    「不要」的作用范围是本人的餐品，不是整桌：阿岚不吃辣，小北依然可以点麦辣鸡腿堡。
    只有共享餐品才需要同时满足所有人的忌口（见 _add_explore）。
    """
    kws = never_map.get(mid) or []
    return [it for it in items if not violates(it, kws)]


def _compose_basic(party: dict, items: list[dict], resolution: dict,
                   never_map: dict, strategy: str) -> list[dict]:
    entries = []
    for m in party.get("members") or []:
        res = resolution.get(m["id"], {})
        pool = _member_eligible(items, never_map, m["id"])
        pick, _ = _pick_primary(m, res, pool, strategy)
        if pick:
            entries.append(_entry(pick, m["id"]))
    return entries


def _add_wish_extras(party: dict, entries: list[dict], items: list[dict], resolution: dict,
                     never_map: dict, budget_cents: int | None) -> tuple[list[dict], list[dict]]:
    """A 方案：用剩余预算补「最好有」，直到预算用完或没有可补项。"""
    added: list[dict] = []
    used = {e["productCode"] for e in entries}
    for m in party.get("members") or []:
        res = resolution.get(m["id"], {})
        pool = _member_eligible(items, never_map, m["id"])
        for _ in range(MAX_EXTRAS_PER_PERSON):
            pick = _pick_extra(m, res, pool, used)
            if not pick:
                break
            projected = _estimate_total(entries + added + [_entry(pick, m["id"])])
            if budget_cents is not None and projected > budget_cents:
                break
            entry = _entry(pick, m["id"])
            added.append(entry)
            used.add(pick["productCode"])
            break
    return entries + added, added


def _add_explore(party: dict, entries: list[dict], eligible: list[dict],
                 budget_cents: int | None) -> tuple[list[dict], list[dict], list[dict]]:
    """C 方案：在心愿骨架之外加探索项；预算不够就退回不加。"""
    used = {e["productCode"] for e in entries}
    pool = sorted((it for it in eligible if it.get("novelty") and it["productCode"] not in used),
                  key=lambda x: x.get("priceCents") or 0)
    added, dropped = [], []
    for it in pool[:MAX_EXPLORE_ITEMS]:
        projected = _estimate_total(entries + added + [_entry(it, None)])
        if budget_cents is not None and projected > budget_cents:
            break
        added.append(_entry(it, None))
    if budget_cents is not None and _estimate_total(entries) > budget_cents and added:
        # 优先保住心愿，探索项让位
        dropped = added
        added = []
    return entries + added, added, dropped


# ---------------------------------------------------------------- 核价

def _price(client, party: dict, entries: list[dict]) -> dict:
    store = party.get("store") or {}
    payload = [{"productCode": e["productCode"], "quantity": e["quantity"]} for e in entries]
    res = client.calculate_price(store.get("storeCode"), payload,
                                 be_type=int(store.get("beType") or 1),
                                 reservation_date=store.get("reservationDate") or None,
                                 be_code=store.get("beCode") or None)
    if res.get("ok"):
        return {"ok": True, "source": res.get("source", "official"),
                "originalTotalCents": res.get("originalTotalCents"),
                "totalCents": res.get("totalCents"),
                "discountCents": res.get("discountCents") or 0,
                "coupon": None,
                "productList": res.get("productList") or [],
                "quotedAt": res.get("dataTime"), "traceId": res.get("traceId"),
                "error": None}
    return {"ok": False, "source": res.get("source", "unavailable"),
            "originalTotalCents": None, "totalCents": None, "discountCents": 0,
            "coupon": None, "productList": [],
            "quotedAt": res.get("dataTime"), "traceId": res.get("traceId"),
            "error": res.get("error") or {"code": "UNKNOWN", "message": "核价失败"}}


def _try_coupon(client, party: dict, entries: list[dict], base_pricing: dict,
                coupons: list[dict]) -> tuple[dict, str | None]:
    """整单更划算：逐张试算可用券，仅当官方实付更低时才采用。

    券是否成立不靠猜，完全交给官方核价接口判定；被拒（如 600012）就如实记录原因。
    """
    if not coupons:
        return base_pricing, None
    if not base_pricing.get("ok"):
        return base_pricing, "官方核价不可用，未试算优惠券"

    codes = {e["productCode"] for e in entries}
    best, best_note = base_pricing, None
    for coupon in coupons:
        products = {p.get("productCode") for p in coupon.get("products") or []}
        hit = codes & products
        if not hit:
            names = "、".join(p.get("productName") or "" for p in coupon.get("products") or [])
            best_note = f"券「{coupon.get('title')}」仅适用于{names}，本单未包含，未使用"
            continue
        # 一张券可能适用于多件餐品：只挂第一个命中商品试算，可能错过更优解（审查报告 P3-10）。
        # 命中商品多时逐个试算会成倍增加官方调用，这里限制最多 3 个。
        store_info = party.get("store") or {}
        res = None
        for code in sorted(hit)[:3]:
            payload = []
            for e in entries:
                row = {"productCode": e["productCode"], "quantity": e["quantity"]}
                if e["productCode"] == code:
                    row["couponId"] = coupon.get("couponId")
                    row["couponCode"] = coupon.get("couponCode")
                payload.append(row)
            attempt = client.calculate_price(store_info.get("storeCode"), payload,
                                            be_type=int(store_info.get("beType") or 1),
                                            reservation_date=store_info.get("reservationDate") or None,
                                            be_code=store_info.get("beCode") or None)
            if attempt.get("ok") and (res is None or (attempt.get("totalCents") or 10 ** 9)
                                      < (res.get("totalCents") or 10 ** 9)):
                res = attempt
            elif res is None:
                res = attempt
        if not res.get("ok"):
            err = (res.get("error") or {}).get("message") or "未知原因"
            best_note = f"券「{coupon.get('title')}」试算被官方拒绝：{err}"
            continue
        if res.get("totalCents") is not None and res["totalCents"] < (best.get("totalCents") or 10 ** 9):
            best = {"ok": True, "source": res.get("source", "official"),
                    "originalTotalCents": res.get("originalTotalCents"),
                    "totalCents": res.get("totalCents"),
                    "discountCents": res.get("discountCents") or 0,
                    "coupon": {"couponId": coupon.get("couponId"), "title": coupon.get("title"),
                               "couponCode": coupon.get("couponCode")},
                    "productList": res.get("productList") or [],
                    "quotedAt": res.get("dataTime"), "traceId": res.get("traceId"),
                    "error": None}
            best_note = f"已套用券「{coupon.get('title')}」，实付按官方核价 %s" % fmt_yuan(res.get("totalCents"))
        else:
            best_note = f"券「{coupon.get('title')}」试算后未更低，未采用"
    return best, best_note


# ---------------------------------------------------------------- 组装

def _finalize(client, party: dict, entries: list[dict], strategy: str, pricing: dict,
              resolution: dict, never_keywords: list[str],
              exclusions: dict, extras: list[dict] | None = None,
              coupon_note: str | None = None, baseline_total: int | None = None,
              converged_with: str | None = None) -> dict:
    meta = STRATEGY_META[strategy]
    entries = _merge(entries)
    total = pricing.get("totalCents") if pricing.get("ok") else _estimate_total(entries)
    allocation, alloc_warnings = build_allocation(party, entries, pricing)
    wish_results, wish_warnings = build_wish_results(party, entries, resolution, never_keywords)
    budget_info = check_budget(party, total)

    party_ctx = dict(party)
    party_ctx["_allocation"] = allocation
    tradeoffs = build_tradeoffs(strategy, party_ctx, entries, pricing, wish_results, budget_info,
                                excluded_count=exclusions.get("count", 0),
                                excluded_examples=exclusions.get("examples"),
                                novelty_added=extras if strategy == "explore" else None,
                                baseline_total=baseline_total,
                                coupon_note=coupon_note,
                                converged_with=converged_with)

    warnings = list(dict.fromkeys(alloc_warnings + wish_warnings))
    if exclusions.get("missingDetail"):
        warnings.append(f"有 {exclusions['missingDetail']} 款餐品未取得套餐组成，忌口仅按名称校验")
    if not pricing.get("ok"):
        warnings.append("官方核价不可用：本方案的金额不可作为成交价参考")
    if pricing.get("source") == "replay":
        warnings.append("价格来自离线回放缓存，非实时结果")

    return {
        "planId": meta["planId"],
        "strategy": strategy,
        "name": meta["name"],
        "subtitle": meta["subtitle"],
        "items": entries,
        "pricing": {k: v for k, v in pricing.items() if k != "productList"} | {
            "productList": pricing.get("productList") or []},
        "allocation": allocation,
        "wishResults": wish_results,
        "tradeoffs": tradeoffs,
        "warnings": warnings,
        "budget": {"budgetCents": budget_info["budgetCents"],
                   "over": budget_info["over"],
                   "diffCents": budget_info["diffCents"],
                   "perHeadCents": per_head_cents(total, len(party.get("members") or []))},
        "convergedWith": converged_with,
    }


def _signature(plan: dict) -> tuple:
    return tuple(sorted((it["productCode"], it["quantity"]) for it in plan["items"]))


def generate_plans(party: dict, items: list[dict], client, resolution: dict | None = None,
                   coupons: list[dict] | None = None, missing_detail: int = 0,
                   ctx: dict | None = None) -> dict:
    """生成三套方案。调用方负责取菜单/详情/券，本函数只做规则计算与核价。

    `ctx` 可由调用方传入（`party_context` 的结果）：心愿匹配要跑 difflib，
    一次请求里算三遍纯属浪费（审查报告 P2-1）。
    """
    ctx = ctx or party_context(party, items)
    items = ctx["items"]
    resolution = resolution or ctx["resolution"]
    never_map = ctx["neverMap"]
    never_keywords = ctx["neverKeywords"]
    shared_eligible = ctx["eligible"]          # 共享餐品要避开所有人的忌口
    coupons = coupons or []

    unknown_never = []
    for m in party.get("members") or []:
        for entry in resolution.get(m["id"], {}).get("never") or []:
            if entry.get("literalOnly"):
                unknown_never.append(entry["wish"])

    if not items:
        return {"plans": [], "meta": {
            "warnings": ["当前门店没有可售餐品，请更换门店或稍后重试"],
            "exclusions": {"count": 0, "examples": []}}}

    budget_cents = check_budget(party, 0)["budgetCents"]
    exclusions = {"count": len(ctx["excluded"]),
                  "examples": [f"{it['name']}（含{hit}）" for it, hit in ctx["excluded"][:3]],
                  "missingDetail": missing_detail}

    # ---- B 整单更划算（先算，作为 A/C 的价格基线）
    value_entries = _compose_basic(party, items, resolution, never_map, "value")
    value_base = _price(client, party, value_entries)
    value_pricing, coupon_note = _try_coupon(client, party, value_entries, value_base, coupons)
    value_plan = _finalize(client, party, value_entries, "value", value_pricing, resolution,
                           never_keywords, exclusions, coupon_note=coupon_note,
                           baseline_total=value_pricing.get("totalCents") if value_pricing.get("ok") else None)
    baseline_total = value_plan["pricing"].get("totalCents")

    # ---- A 人人有期待
    basic = _compose_basic(party, items, resolution, never_map, "balanced")
    entries_a, extras_a = _add_wish_extras(party, basic, items, resolution, never_map, budget_cents)
    pricing_a = _price(client, party, entries_a)
    # 官方核价可能高于预估（组合价/配餐差价）：超预算则逐件撤回配餐后重算
    for _ in range(len(extras_a)):
        if not pricing_a.get("ok") or budget_cents is None or pricing_a["totalCents"] <= budget_cents:
            break
        extras_a = extras_a[:-1]
        entries_a = _merge(basic + extras_a)
        pricing_a = _price(client, party, entries_a)
    plan_a = _finalize(client, party, entries_a, "balanced", pricing_a, resolution,
                       never_keywords, exclusions, extras=extras_a,
                       coupon_note="本方案未叠加优惠券；用券测算见「整单更划算」",
                       baseline_total=baseline_total)

    # ---- C 一起尝点新（探索项是共享的，必须避开所有人忌口）
    entries_c, added_c, dropped_c = _add_explore(party, basic, shared_eligible, budget_cents)
    pricing_c = _price(client, party, entries_c)
    if (not pricing_c.get("ok") or (budget_cents is not None and pricing_c.get("totalCents", 0) > budget_cents)) and added_c:
        entries_c = _merge(basic)
        pricing_c = _price(client, party, entries_c)
        dropped_c, added_c = added_c, []
    plan_c = _finalize(client, party, entries_c, "explore", pricing_c, resolution,
                       never_keywords, exclusions, extras=added_c,
                       coupon_note="尝新项未叠加优惠券；用券测算见「整单更划算」",
                       baseline_total=baseline_total)
    if dropped_c:
        plan_c["tradeoffs"].append({"type": "budget",
                                    "text": "探索项因超出共同预算未纳入："
                                            + "、".join(x["name"] for x in dropped_c)})

    plans = [plan_a, plan_b_order(value_plan), plan_c]

    # ---- 收敛检测：如实说明，不为凑差异改结果
    sig_groups: dict[tuple, list[dict]] = {}
    for p in plans:
        sig_groups.setdefault(_signature(p), []).append(p)
    for group in sig_groups.values():
        if len(group) < 2:
            continue
        for p in group:
            others = [q["name"] for q in group if q is not p]
            p["convergedWith"] = "、".join(others)
            p["tradeoffs"].append({
                "type": "converged",
                "text": f"与「{'、'.join(others)}」的餐品完全相同：在当前菜单与硬约束下，"
                        f"这三套策略没有可产生差异的替代组合，因此不制造人为区别"})

    warnings = []
    if unknown_never:
        warnings.append("以下忌口未在内置词表中，仅按字面匹配：" + "、".join(unknown_never))
    if party.get("dataSource") == "replay":
        warnings.append("当前数据来自离线回放，非实时菜单与价格")
    if ctx.get("skippedNoPrice"):
        warnings.append("有 %d 款商品未取到官方价格，未纳入候选（数据缺失，不代表门店没有）"
                        % ctx["skippedNoPrice"])
    return {"plans": plans, "meta": {
        "warnings": warnings,
        "exclusions": {"count": len(ctx["excluded"]), "examples": exclusions["examples"]},
        "eligibleCount": len(ctx["eligible"]),
        "dataTime": party.get("dataTime"),
        "dataSource": party.get("dataSource", "live"),
        "wishResolution": resolution,
        "neverKeywords": never_keywords,
    }}


def plan_b_order(plan: dict) -> dict:
    """B 方案放在中间展示（价格最优通常最受关注），保持界面顺序稳定。"""
    plan["order"] = 2
    return plan


# ---------------------------------------------------------------- 手动调整后复算

def party_context(party: dict, items: list[dict]) -> dict:
    """把「硬约束 → 可售集 → 心愿解析」这套前置计算收敛到一个入口。"""
    all_items = mark_flags([dict(it) for it in items])
    # 官方价格为空串时换算为 0 分：这类商品不能进方案，但必须让用户知道是「数据缺失」
    # 而不是「本店没有」（审查报告 P2-9）
    skipped_no_price = [it for it in all_items if (it.get("priceCents") or 0) <= 0]
    items = [it for it in all_items if (it.get("priceCents") or 0) > 0]
    resolution = resolve_wishes(party.get("members") or [], items)

    never_map: dict[str, list[str]] = {}
    for m in party.get("members") or []:
        kws: list[str] = []
        for entry in resolution.get(m["id"], {}).get("never") or []:
            for kw in entry.get("keywords") or []:
                if kw not in kws:
                    kws.append(kw)
        never_map[m["id"]] = kws

    # 共享餐品要避开所有人的忌口，所以这里用并集；个人餐品用 never_map 逐人判断
    union: list[str] = []
    for kws in never_map.values():
        for kw in kws:
            if kw not in union:
                union.append(kw)

    eligible, excluded = [], []
    for it in items:
        hit = violates(it, union)
        if hit:
            excluded.append((it, hit))
        else:
            eligible.append(it)

    return {"items": items, "resolution": resolution, "neverMap": never_map,
            "neverKeywords": union, "eligible": eligible, "excluded": excluded,
            "skippedNoPrice": len(skipped_no_price)}


def recalc_plan(party: dict, menu_items: list[dict], client, entries: list[dict],
                strategy: str = "balanced", missing_detail: int = 0,
                plan_id: str | None = None) -> dict:
    """用户手动改餐品后重新组单 + 重新核价（规划 §5.5 / B05）。

    关键约束：改动后必须重新核价，旧价格立即作废。若核价失败，返回的 pricing.ok=false，
    调用方不得继续展示旧金额。
    """
    ctx = party_context(party, menu_items)
    by_code = {it["productCode"]: it for it in ctx["items"]}
    never_map = ctx["neverMap"]
    valid_ids = {m["id"] for m in party.get("members") or []}

    composed = []
    rejected = []
    incomplete_coupon = False
    for row in (entries or [])[:MAX_ROWS]:
        item = by_code.get(row.get("productCode"))
        if not item:
            rejected.append(f"未知餐品 {row.get('productCode')}")
            continue
        try:
            qty = int(row.get("quantity", 1))
        except (TypeError, ValueError):
            rejected.append(f"{item.get('name')}：数量必须是整数")
            continue
        if not (1 <= qty <= MAX_QUANTITY):
            rejected.append(f"{item.get('name')}：数量需在 1—{MAX_QUANTITY} 之间（收到 {row.get('quantity')}）")
            continue
        assignee = row.get("assigneeId")
        # 忌口按归属人判断；共享项（无归属）要满足所有人
        kws = never_map.get(assignee) if assignee in valid_ids else ctx["neverKeywords"]
        hit = violates(item, kws or [])
        if hit:
            who = "共享餐品" if assignee not in valid_ids else ""
            rejected.append(f"{item.get('name')}（含「{hit}」{('，' + who) if who else ''}）")
            continue
        entry = _entry(item, assignee if assignee in valid_ids else None, qty)
        if row.get("couponId"):
            entry["_couponId"] = row["couponId"]
            entry["_couponCode"] = row.get("couponCode")
            if not row.get("couponCode"):
                incomplete_coupon = True
        composed.append(entry)

    if not composed:
        return {"ok": False, "error": {"code": "EMPTY_PLAN",
                                       "message": "调整后的清单为空或全部触碰硬约束"}}

    store = party.get("store") or {}
    payload = []
    coupon_used = None
    for e in composed:
        row = {"productCode": e["productCode"], "quantity": e["quantity"]}
        if e.get("_couponId") and e.get("_couponCode"):
            # couponId 与 couponCode 必须成对下发，只给 id 会被官方 600012 拒绝
            row["couponId"] = e["_couponId"]
            row["couponCode"] = e["_couponCode"]
            coupon_used = e["_couponId"]
        payload.append(row)
    res = client.calculate_price(store.get("storeCode"), payload,
                                 be_type=int(store.get("beType") or 1),
                                 reservation_date=store.get("reservationDate") or None)
    pricing = ({"ok": True, "source": res.get("source", "official"),
                "originalTotalCents": res.get("originalTotalCents"),
                "totalCents": res.get("totalCents"),
                "discountCents": res.get("discountCents") or 0,
                "coupon": {"couponId": coupon_used} if coupon_used else None,
                "productList": res.get("productList") or [],
                "quotedAt": res.get("dataTime"), "traceId": res.get("traceId"), "error": None}
               if res.get("ok") else
               {"ok": False, "source": res.get("source", "unavailable"),
                "originalTotalCents": None, "totalCents": None, "discountCents": 0,
                "coupon": None, "productList": [], "quotedAt": res.get("dataTime"),
                "traceId": res.get("traceId"),
                "error": res.get("error") or {"code": "UNKNOWN", "message": "核价失败"}})

    exclusions = {"count": len(ctx["excluded"]),
                  "examples": [f"{it['name']}（含{hit}）" for it, hit in ctx["excluded"][:3]],
                  "missingDetail": missing_detail}
    plan = _finalize(client, party, composed, strategy, pricing, ctx["resolution"],
                     ctx["neverKeywords"], exclusions,
                     coupon_note="已按当前清单重新核价" if pricing["ok"] else None)
    if plan_id:
        plan["planId"] = plan_id
    if rejected:
        plan["warnings"].append("以下条目未纳入：" + "、".join(str(x) for x in rejected))
    if incomplete_coupon:
        plan["warnings"].append("券信息不完整（缺少 couponCode），本次按无券核价")
    return {"ok": True, "plan": plan, "rejected": rejected}
