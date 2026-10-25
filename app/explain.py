# -*- coding: utf-8 -*-
"""方案解释文案生成（规划 §5.4 / §8.2 B04 / 验收 12.3）。

原则：解释只陈述可核对的事实——谁的心愿由哪件餐品满足、哪条硬约束排除了什么、
优惠成立的条件是什么、超出预算多少。不生成「公平分」「推荐指数」这类无法解释的伪指标。
"""
from __future__ import annotations

from .rules import fmt_yuan, item_haystack, normalize

STRATEGY_META = {
    "balanced": {"planId": "A", "name": "人人有期待", "subtitle": "优先照顾每位成员的核心心愿"},
    "value": {"planId": "B", "name": "整单更划算", "subtitle": "满足硬约束后尽量压低整单支出"},
    "explore": {"planId": "C", "name": "一起尝点新", "subtitle": "保留核心心愿，加入一点探索"},
}


def _item_matches_wish(item: dict, wish: str, matches: list[dict]) -> bool:
    """判断这件餐品是否算满足了某条心愿。

    以菜单匹配结果为准（宁可少算）；同时允许「餐品名/套餐组成包含心愿词」这种显而易见的情形。
    """
    if item.get("productCode") in {m.get("productCode") for m in matches}:
        return True
    return normalize(wish) and normalize(wish) in item_haystack(item)


def build_wish_results(party: dict, items: list[dict], resolution: dict,
                       never_keywords: list[str]) -> tuple[dict, list[str]]:
    """逐人逐条给出心愿处理结果，并返回 (wishResults, warnings)。"""
    shared_items = [it for it in items if it.get("shared") or not it.get("assigneeId")]
    results: dict[str, dict] = {}
    warnings: list[str] = []

    for m in party.get("members") or []:
        mid = m["id"]
        mine = [it for it in items if it.get("assigneeId") == mid] + shared_items
        entry = {"must": [], "nice": [], "never": []}
        res = resolution.get(mid, {})

        for wish_entry in res.get("must") or []:
            wish, matches = wish_entry["wish"], wish_entry.get("matches") or []
            hit = next((it for it in mine if _item_matches_wish(it, wish, matches)), None)
            if hit:
                entry["must"].append({"wish": wish, "status": "satisfied",
                                      "byProduct": hit.get("name"), "reason": ""})
                continue
            if not matches:
                reason = f"本店当前菜单没有匹配「{wish}」的餐品"
            else:
                # 与 rules.violates 同口径：套餐组成也要看，否则「三件套里含麦辣」会被漏判
                blocked = [x for x in matches
                           if any(kw and kw in item_haystack({"name": x.get("name"),
                                                              "components": x.get("components") or []})
                                  for kw in never_keywords)]
                if blocked and len(blocked) == len(matches):
                    reason = f"匹配到的 {len(matches)} 款都触碰了同桌的硬约束，被排除"
                else:
                    reason = "本方案未纳入该餐品（预算或搭配优先级靠后），可手动添加"
            entry["must"].append({"wish": wish, "status": "unmet", "byProduct": None, "reason": reason})

        for wish_entry in res.get("nice") or []:
            wish, matches = wish_entry["wish"], wish_entry.get("matches") or []
            hit = next((it for it in mine if _item_matches_wish(it, wish, matches)), None)
            entry["nice"].append({"wish": wish,
                                  "status": "satisfied" if hit else "unmet",
                                  "byProduct": hit.get("name") if hit else None,
                                  "reason": "" if hit else ("本店无匹配餐品" if not matches else "本方案未纳入")})

        # 「不要」是硬约束，但作用范围是这个人自己吃的东西（+ 共享餐品）：
        # 别人不吃辣，不代表我不能点麦辣鸡腿堡。这里如实按「归属 + 共享」核对。
        for never_entry in res.get("never") or []:
            wish = never_entry["wish"]
            kws = never_entry.get("keywords") or []
            bad = next((it for it in mine
                        if any(kw and kw in item_haystack(it) for kw in kws)), None)
            if bad:
                entry["never"].append({"wish": wish, "status": "violated",
                                       "reason": f"「{bad.get('name')}」命中该忌口"})
                warnings.append(f"{m.get('nickname')} 的「不要 {wish}」被「{bad.get('name')}」破坏")
            else:
                note = "仅按名称校验" if never_entry.get("literalOnly") else "属于该成员的餐品已避开该忌口"
                entry["never"].append({"wish": wish, "status": "respected", "reason": note})

        results[mid] = entry
    return results, warnings


def _unmet_must(wish_results: dict, party: dict) -> list[tuple[str, str, str]]:
    out = []
    names = {m["id"]: m.get("nickname") for m in party.get("members") or []}
    for mid, r in wish_results.items():
        for item in r.get("must") or []:
            if item["status"] != "satisfied":
                out.append((names.get(mid) or mid, item["wish"], item.get("reason") or ""))
    return out


def build_tradeoffs(strategy: str, party: dict, items: list[dict], pricing: dict,
                    wish_results: dict, budget_info: dict,
                    excluded_count: int = 0, excluded_examples: list[str] | None = None,
                    novelty_added: list[dict] | None = None,
                    baseline_total: int | None = None,
                    coupon_note: str | None = None,
                    converged_with: str | None = None) -> list[dict]:
    """生成取舍说明。每条都必须能被用户对着清单核对。"""
    out: list[dict] = []
    total = pricing.get("totalCents") if pricing.get("ok") else None
    meta = STRATEGY_META.get(strategy, {})

    # 1) 价格事实
    if pricing.get("ok"):
        if pricing.get("discountCents"):
            out.append({"type": "coupon",
                        "text": "整单官方核价 %s，优惠 %s，实付 %s（优惠按官方核价结果计入）"
                                % (fmt_yuan(pricing.get("originalTotalCents")),
                                   fmt_yuan(pricing.get("discountCents")),
                                   fmt_yuan(total))})
        elif not coupon_note:
            out.append({"type": "price",
                        "text": "整单官方核价 %s，当前未产生优惠" % fmt_yuan(total)})
        if coupon_note:
            out.append({"type": "coupon", "text": coupon_note})
    else:
        err = (pricing.get("error") or {}).get("message") or "官方核价不可用"
        out.append({"type": "price",
                    "text": f"官方核价失败（{err}），本方案不展示成交价，也不能据此判断贵或便宜"})

    # 2) 策略目标与代价
    if strategy == "balanced":
        if total is not None and baseline_total is not None:
            delta = total - baseline_total
            if delta > 0:
                out.append({"type": "price",
                            "text": "比最省的一套多花 %s，换来更多成员的「必须要」被满足"
                                    % fmt_yuan(delta)})
            elif delta == 0:
                out.append({"type": "price", "text": "与最省的一套同价，心愿满足没有额外成本"})
            else:
                # 优惠券/组合价可能让「照顾心愿」这套反而更便宜，别写成「同价（¥-2.00）」
                out.append({"type": "price",
                            "text": "比最省的一套反而省 %s（官方核价结果）" % fmt_yuan(-delta)})
        unmet_nice = sum(1 for r in wish_results.values() for x in r.get("nice") or []
                         if x["status"] == "unmet")
        if unmet_nice:
            out.append({"type": "wish", "text": f"有 {unmet_nice} 条「最好有」心愿未纳入，用于控制总价"})
    elif strategy == "value":
        out.append({"type": "price", "text": "在满足「不要」硬约束、尽量满足「必须要」的前提下选最省的搭配"})
        adjusted = [(m, x) for m, r in wish_results.items() for x in r.get("must") or []
                    if x["status"] != "satisfied"]
        if adjusted:
            out.append({"type": "wish",
                        "text": "为压价，有 %d 条「必须要」未满足，已在下方逐条列出" % len(adjusted)})
    elif strategy == "explore":
        if novelty_added:
            names = "、".join(f"{x.get('name')}（{fmt_yuan(x.get('unitPriceCents'))}）" for x in novelty_added[:3])
            out.append({"type": "price", "text": f"新增探索餐品：{names}"})
        else:
            out.append({"type": "price", "text": "当前菜单没有可纳入的新品尝鲜项，本方案未强行加入新品"})
        if total is not None and baseline_total is not None:
            delta = total - baseline_total
            out.append({"type": "price",
                        "text": ("尝新使整单增加 %s" % fmt_yuan(delta)) if delta > 0
                                else ("尝新后整单反而减少 %s" % fmt_yuan(-delta))})

    # 3) 未满足的「必须要」
    unmet = _unmet_must(wish_results, party)
    for nickname, wish, reason in unmet:
        out.append({"type": "wish", "text": f"{nickname} 的「{wish}」未满足：{reason}"})

    # 4) 硬约束代价
    if excluded_count:
        examples = "、".join(excluded_examples or [])
        tail = f"，例如 {examples}" if examples else ""
        out.append({"type": "constraint",
                    "text": f"有 {excluded_count} 款餐品包含同桌提到的忌口，不会出现在相应成员的个人餐品或共享餐品中{tail}"})

    # 5) 预算
    if budget_info.get("budgetCents") is not None and total is not None:
        if budget_info["over"]:
            out.append({"type": "budget",
                        "text": "超出共同预算 %s，可减少配餐或改选更省的方案"
                                % fmt_yuan(budget_info["diffCents"])})
        else:
            out.append({"type": "budget",
                        "text": "共同预算剩余 %s" % fmt_yuan(-budget_info["diffCents"])})
    over_members = [a for a in (party.get("_allocation") or []) if a.get("overBudget")]
    if over_members:
        names = "、".join(a["nickname"] for a in over_members)
        out.append({"type": "budget", "text": f"{names} 的个人预算被超出，分摊明细已标出"})

    # 6) 收敛说明
    if converged_with:
        out.append({"type": "converged",
                    "text": f"本方案与「{converged_with}」选的餐品完全一致，原因是当前菜单下"
                            f"（硬约束排除 {excluded_count} 款）没有可产生差异的替代项；"
                            f"三套策略并非被强制区分"})
    return out


# 说明：主题句的唯一实现放在 ticket.py（票根是它的唯一消费方）。
# 这里曾有一份重复实现，文案与长度上限都和票根版不一致，已删除（审查报告 P3-6）。
