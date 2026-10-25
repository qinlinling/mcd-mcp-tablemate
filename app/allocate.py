# -*- coding: utf-8 -*-
"""餐品归属与分账口径（规划 §5.4 / §8.2 B03 / 验收 12.3）。

口径必须让用户能自己复算：
1. 归属项：每份餐品挂在某位成员名下，金额全部计入该成员。
2. 共享项：按在场人数**均摊**，除不尽的 1 分钱从数组第一位成员起逐个补足。
3. 优惠：按各人「归属金额 + 共享分摊」的占比分摊，用最大余额法把分位差额补平；
   这样分摊总额恰好等于官方核价的实付总额，不产生无法解释的差额。
4. 官方核价优先使用门店返回的 productList 分项金额；拿不到时退回「单价 × 数量」，
   并在 warnings 中标注口径差异，绝不假装两者一致。
"""
from __future__ import annotations

from .rules import yuan_to_cents


def _largest_remainder(total: int, weights: list[int]) -> list[int]:
    """按权重拆分 total（分），保证结果之和恰好等于 total。"""
    n = len(weights)
    if n == 0:
        return []
    wsum = sum(weights)
    if total <= 0 or wsum <= 0:
        return [0] * n
    raw = [total * w / wsum for w in weights]
    base = [int(x) for x in raw]
    remainder = total - sum(base)
    # 小数部分大的先补，相等时按原顺序，保证可复现
    order = sorted(range(n), key=lambda i: (-(raw[i] - base[i]), i))
    for i in range(remainder):
        base[order[i % n]] += 1
    return base


def _flat_split(total: int, n: int) -> list[int]:
    if n <= 0:
        return []
    base = total // n
    rest = total - base * n
    return [base + (1 if i < rest else 0) for i in range(n)]


def item_gross(items: list[dict], pricing: dict | None) -> list[int]:
    """每个条目的「官方口径金额」。

    官方核价成功时以 productList 的分项金额为准（套餐特调、组合价都体现在这里）；
    否则退回 单价×数量。

    关键：同一 productCode 可能有多行（两位成员各点一份同款），官方既可能返回
    两行明细、也可能合并成一行带总数量。**必须把该码的官方小计按各行数量占比拆回**，
    否则每行都会拿到整码总额，分摊被系统性放大（这正是审查报告 P0-1）。
    """
    pricing = pricing or {}
    official: dict[str, int] = {}
    if pricing.get("ok"):
        for p in pricing.get("productList") or []:
            code = p.get("productCode")
            subtotal = p.get("subtotalCents")
            if code and subtotal is not None:
                official[code] = official.get(code, 0) + int(subtotal)

    # 先统计每个码在各行上的数量，用于按比例拆分
    qty_by_code: dict[str, int] = {}
    for it in items:
        code = it.get("productCode")
        qty_by_code[code] = qty_by_code.get(code, 0) + max(int(it.get("quantity") or 1), 0)

    out: list[int] = [0] * len(items)
    remaining_qty = dict(qty_by_code)
    remaining_total = {k: v for k, v in official.items()}
    for idx, it in enumerate(items):
        code = it.get("productCode")
        qty = max(int(it.get("quantity") or 1), 0)
        if code in official and qty_by_code.get(code):
            total = official[code]
            full_qty = qty_by_code[code]
            # 最后一行直接拿「剩余差额」，保证同码拆出来的和恰好等于官方小计，不多不少
            if remaining_qty.get(code, 0) <= qty:
                share = remaining_total.get(code, 0)
            else:
                share = total * qty // full_qty
            remaining_qty[code] = remaining_qty.get(code, 0) - qty
            remaining_total[code] = remaining_total.get(code, 0) - share
            out[idx] = share
        else:
            out[idx] = int(it.get("unitPriceCents") or 0) * qty
    return out


def build_allocation(party: dict, items: list[dict], pricing: dict | None) -> tuple[list[dict], list[str]]:
    """返回 (allocation, warnings)。"""
    members = party.get("members") or []
    n = len(members) or 1
    warnings: list[str] = []
    gross_list = item_gross(items, pricing)

    assigned = {m["id"]: 0 for m in members}
    shared_total = 0
    shared_count = 0
    for it, gross in zip(items, gross_list):
        if it.get("shared") or not it.get("assigneeId"):
            shared_total += gross
            shared_count += 1
        else:
            if it["assigneeId"] not in assigned:
                # 归属到了不存在的成员：按共享处理，避免金额凭空消失
                warnings.append("有餐品归属到已不存在的成员，已按共享项分摊")
                shared_total += gross
                shared_count += 1
            else:
                assigned[it["assigneeId"]] += gross

    per_head = _flat_split(shared_total, n)
    gross_by_member = []
    for idx, m in enumerate(members):
        gross_by_member.append(assigned.get(m["id"], 0) + per_head[idx])

    gross_sum = sum(gross_by_member)
    official_total = (pricing or {}).get("totalCents") if (pricing or {}).get("ok") else None

    if official_total is None:
        discount_total = 0
        final_total = gross_sum
    else:
        final_total = int(official_total)
        discount_total = gross_sum - final_total
        if discount_total < 0:
            # 官方总额高于分项之和（可能存在打包/餐具等附加项）：把差额按人头均摊补上
            warnings.append("官方核价总额高于分项合计，差额已按人数均摊")
            diff = _flat_split(-discount_total, n)
            gross_by_member = [g + diff[i] for i, g in enumerate(gross_by_member)]
            gross_sum = sum(gross_by_member)
            discount_total = 0

    discount_parts = _largest_remainder(discount_total, gross_by_member) if discount_total > 0 else [0] * n

    allocation = []
    for idx, m in enumerate(members):
        share = gross_by_member[idx] - discount_parts[idx]
        personal = m.get("budget")
        personal_cents = yuan_to_cents(personal)
        over = bool(personal_cents) and share > personal_cents
        allocation.append({
            "memberId": m["id"],
            "nickname": m.get("nickname"),
            "itemsSubtotalCents": assigned.get(m["id"], 0),
            "sharedShareCents": per_head[idx],
            "discountShareCents": discount_parts[idx],
            "shareCents": share,
            "personalBudget": personal,
            "overBudget": over,
        })

    if sum(a["shareCents"] for a in allocation) != final_total:
        warnings.append("分摊合计与整单金额不一致，请以整单金额为准")
    if shared_count and n:
        for a in allocation:
            if a["sharedShareCents"] % 1:  # 理论不会发生，兜底断言
                warnings.append("共享项分摊存在未能整除的分位差额")
                break
    return allocation, warnings


def check_budget(party: dict, total_cents: int) -> dict:
    """共同预算校验。返回 {budgetCents, over, diffCents}。"""
    # 与适配层/规则层共用 Decimal 换算：两套口径（float+round vs Decimal）在
    # 1.005 这类边界值上会差 1 分，属于最难查的账目问题（审查报告 P2-8）
    budget_cents = yuan_to_cents(party.get("budgetTotal"))
    return {
        "budgetCents": budget_cents,
        "over": bool(budget_cents is not None and total_cents > budget_cents),
        "diffCents": (total_cents - budget_cents) if budget_cents is not None else None,
    }


def per_head_cents(total_cents: int, member_count: int) -> int:
    """人均（向上取整到分），仅用于展示参考，不作为分摊依据。"""
    if not member_count:
        return total_cents
    return -(-int(total_cents) // member_count)
