# -*- coding: utf-8 -*-
"""规则引擎回归测试（规划 E01/E02）。

用真实门店菜单快照（tests/fixtures/menu_1450713.json，2026-10-25 抓取）作为输入，
用假的核价器替代网络，保证测试可离线、可重复。
断言的核心是「不可协商的不变量」，不是具体价格数字：
- 硬约束「不要」绝不被突破；
- 分摊合计 == 整单金额；
- 未满足的心愿必须带原因；
- 三套策略收敛时必须有说明。
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.allocate import _flat_split, _largest_remainder, build_allocation, check_budget
from app.mcd_mcp import McdClient  # noqa: F401  仅用于确保依赖可导入
from app.rules import (expand_never, fmt_yuan, item_kind, mark_flags, resolve_wishes,
                       validate_party, violates)
from app.strategy import candidate_codes, generate_plans, party_context, recalc_plan

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "menu_1450713.json")
CASES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cases.json")


def load_menu():
    with open(FIXTURE, encoding="utf-8") as f:
        return mark_flags(json.load(f)["items"])


def load_cases():
    with open(CASES, encoding="utf-8") as f:
        return json.load(f)["cases"]


class FakeClient:
    """模拟官方核价：按菜单单价求和；可选地为带 couponId 的条目打折。"""

    def __init__(self, menu, coupon_discount=0, fail=False):
        self.by_code = {it["productCode"]: it for it in menu}
        self.coupon_discount = coupon_discount
        self.fail = fail
        self.calls = []

    def calculate_price(self, store_code, items, be_type=1, reservation_date=None, be_code=None):
        self.calls.append(items)
        if self.fail:
            return {"ok": False, "error": {"code": "NETWORK", "message": "模拟网络失败"},
                    "source": "unavailable", "dataTime": None, "traceId": None}
        rows, total = [], 0
        coupon_hit = False
        for row in items:
            it = self.by_code.get(row["productCode"])
            unit = (it or {}).get("priceCents") or 0
            qty = int(row.get("quantity") or 1)
            rows.append({"productCode": row["productCode"], "productName": (it or {}).get("name"),
                         "quantity": qty, "subtotalCents": unit * qty,
                         "originalSubtotalCents": unit * qty})
            total += unit * qty
            if row.get("couponId"):
                coupon_hit = True
        discount = self.coupon_discount if coupon_hit else 0
        return {"ok": True, "source": "official", "originalTotalCents": total,
                "totalCents": total - discount, "discountCents": discount,
                "productList": rows, "dataTime": "2026-10-25 15:00:00",
                "traceId": "fake-0001", "error": None}


class TestRules(unittest.TestCase):
    def test_never_dict_expands(self):
        kws, unknown = expand_never(["辣"])
        self.assertIn("辣", kws)
        self.assertEqual(unknown, [])

    def test_free_form_never_is_literal(self):
        kws, unknown = expand_never(["榴莲"])
        self.assertIn("榴莲", kws)
        self.assertEqual(unknown, ["榴莲"])

    def test_violation_checks_components(self):
        item = {"name": "三件套", "components": ["麦辣鸡腿汉堡", "中薯条"], "tags": []}
        self.assertEqual(violates(item, ["辣"]), "辣")
        self.assertIsNone(violates(item, ["牛肉"]))

    def test_validate_requires_members_matching_count(self):
        party = {"title": "测试", "memberCount": 4, "budgetTotal": 100,
                 "store": {"storeCode": "1450713", "beType": 1},
                 "members": [{"id": "m1", "nickname": "A"}]}
        errors = validate_party(party)
        self.assertTrue(any("不一致" in e["message"] for e in errors))

    def test_validate_detects_must_never_clash(self):
        party = {"title": "测试", "memberCount": 3, "budgetTotal": 100,
                 "store": {"storeCode": "1450713", "beType": 1},
                 "members": [{"id": f"m{i}", "nickname": f"人{i}", "must": ["巨无霸"], "never": ["巨无霸"]}
                             for i in range(1, 4)]}
        errors = validate_party(party)
        self.assertTrue(any("同时出现在" in e["message"] for e in errors))

    def test_standard_case_is_valid(self):
        case = load_cases()[0]
        self.assertEqual(validate_party(case["party"]), [])

    def test_money_format(self):
        self.assertEqual(fmt_yuan(3350), "¥33.50")
        self.assertEqual(fmt_yuan(None), "未知")


class TestAllocation(unittest.TestCase):
    def test_flat_split_keeps_sum(self):
        for total, n in [(100, 3), (7, 3), (0, 4), (1, 8)]:
            parts = _flat_split(total, n)
            self.assertEqual(sum(parts), total)
            self.assertEqual(len(parts), n)
            self.assertLessEqual(max(parts) - min(parts), 1)

    def test_largest_remainder_keeps_sum(self):
        self.assertEqual(sum(_largest_remainder(1352, [1000, 2000, 3000])), 1352)

    def test_share_total_equals_official_total(self):
        party = {"members": [{"id": "m1", "nickname": "A", "budget": None},
                             {"id": "m2", "nickname": "B", "budget": None},
                             {"id": "m3", "nickname": "C", "budget": None}]}
        items = [{"productCode": "x", "quantity": 1, "unitPriceCents": 1000, "assigneeId": "m1"},
                 {"productCode": "y", "quantity": 1, "unitPriceCents": 500, "assigneeId": None}]
        pricing = {"ok": True, "totalCents": 1352, "productList": [
            {"productCode": "x", "subtotalCents": 1000},
            {"productCode": "y", "subtotalCents": 500}]}
        alloc, warnings = build_allocation(party, items, pricing)
        self.assertEqual(sum(a["shareCents"] for a in alloc), 1352)
        # 优惠 148 分按占比分给三人，A 拿最多
        self.assertGreater(alloc[0]["discountShareCents"], 0)
        self.assertEqual(warnings, [])

    def test_budget_check(self):
        info = check_budget({"budgetTotal": 100}, 12000)
        self.assertTrue(info["over"])
        self.assertEqual(info["diffCents"], 2000)


class TestStrategy(unittest.TestCase):
    def setUp(self):
        self.menu = load_menu()
        self.cases = load_cases()

    def run_case(self, case, coupon_discount=0, fail=False, coupons=None):
        client = FakeClient(self.menu, coupon_discount=coupon_discount, fail=fail)
        result = generate_plans(case["party"], self.menu, client, coupons=coupons or [])
        return result, client

    def test_three_plans_generated(self):
        result, _ = self.run_case(self.cases[0])
        self.assertEqual(len(result["plans"]), 3)
        self.assertEqual([p["strategy"] for p in result["plans"]], ["balanced", "value", "explore"])

    def test_hard_constraint_never_violated(self):
        """「不要」的作用范围是本人的餐品；共享餐品必须满足所有人。"""
        for case in self.cases:
            result, _ = self.run_case(case)
            member_kws = {}
            union = []
            for m in case["party"]["members"]:
                kws, _ = expand_never(m.get("never") or [])
                member_kws[m["id"]] = kws
                union.extend(k for k in kws if k not in union)
            for plan in result["plans"]:
                for it in plan["items"]:
                    kws = union if it.get("shared") or not it.get("assigneeId") \
                        else member_kws.get(it["assigneeId"], [])
                    hit = violates(it, kws)
                    self.assertIsNone(
                        hit, f"{case['id']} {plan['planId']} 违反硬约束：{it['name']}/{hit}")

    def test_allocation_invariant_on_every_plan(self):
        for case in self.cases:
            result, _ = self.run_case(case)
            for plan in result["plans"]:
                total = plan["pricing"]["totalCents"]
                self.assertEqual(sum(a["shareCents"] for a in plan["allocation"]), total,
                                 f"{case['id']} {plan['planId']} 分摊与整单不一致")

    def test_unmet_wishes_always_have_reason(self):
        for case in self.cases:
            result, _ = self.run_case(case)
            for plan in result["plans"]:
                for mid, r in plan["wishResults"].items():
                    for entry in r["must"] + r["nice"]:
                        if entry["status"] != "satisfied":
                            self.assertTrue(entry["reason"], f"{mid} 未满足但没给原因")

    def test_matched_must_wish_is_satisfied_in_balanced(self):
        case = self.cases[0]
        result, _ = self.run_case(case)
        balanced = result["plans"][0]
        satisfied = {e["wish"] for r in balanced["wishResults"].values()
                     for e in r["must"] if e["status"] == "satisfied"}
        # 菜单里能匹配到的心愿应当被照顾到（麦辣 / 巨无霸 / 麦旋风）
        self.assertIn("麦辣鸡腿堡", satisfied)
        self.assertIn("巨无霸", satisfied)

    def test_value_plan_not_more_expensive_than_balanced(self):
        for case in self.cases:
            result, _ = self.run_case(case)
            by = {p["strategy"]: p for p in result["plans"]}
            self.assertLessEqual(by["value"]["pricing"]["totalCents"],
                                 by["balanced"]["pricing"]["totalCents"] + 1,
                                 f"{case['id']} 更划算方案反而更贵")

    def test_coupon_is_applied_only_when_cheaper(self):
        case = self.cases[0]
        coupon = {"couponId": "C1", "couponCode": "X1", "title": "测试券",
                  "products": [{"productCode": it["productCode"], "productName": it["name"]} for it in self.menu]}
        result, _ = self.run_case(case, coupon_discount=300, coupons=[coupon])
        value = next(p for p in result["plans"] if p["strategy"] == "value")
        self.assertTrue(value["pricing"]["ok"])
        self.assertEqual(value["pricing"]["discountCents"], 300)
        self.assertIsNotNone(value["pricing"]["coupon"])
        # 不用券的策略不应被塞入优惠，避免三套方案被优惠同化
        balanced = next(p for p in result["plans"] if p["strategy"] == "balanced")
        self.assertEqual(balanced["pricing"]["discountCents"], 0)

    def test_pricing_failure_is_explicit(self):
        result, _ = self.run_case(self.cases[0], fail=True)
        for plan in result["plans"]:
            self.assertFalse(plan["pricing"]["ok"])
            self.assertIsNone(plan["pricing"]["totalCents"])
            self.assertTrue(any(t["type"] == "price" and "核价失败" in t["text"] for t in plan["tradeoffs"]))
            self.assertTrue(any("官方核价不可用" in w for w in plan["warnings"]))

    def test_convergence_is_explained_not_hidden(self):
        result, _ = self.run_case(self.cases[3])  # 8 人重复心愿，容易收敛
        plans = result["plans"]
        sigs = {p["planId"]: tuple(sorted((i["productCode"], i["quantity"]) for i in p["items"]))
                for p in plans}
        for a in plans:
            for b in plans:
                if a is b:
                    continue
                if a["convergedWith"] and b["name"] in a["convergedWith"]:
                    self.assertEqual(sigs[a["planId"]], sigs[b["planId"]])
                    self.assertTrue(any(t["type"] == "converged" for t in a["tradeoffs"]))

    def test_candidate_pool_is_bounded(self):
        case = self.cases[0]
        ctx = party_context(case["party"], [dict(it) for it in self.menu])
        codes = candidate_codes(case["party"], ctx["items"], ctx["resolution"])
        self.assertLessEqual(len(codes), 45)
        self.assertGreater(len(codes), 0)

    def test_recalc_rejects_item_breaking_hard_constraint(self):
        case = self.cases[1]  # 老周(m1) 无忌口；阿岚(m2)、阿紫(m3) 不吃辣
        ctx = party_context(case["party"], [dict(it) for it in self.menu])
        spicy = next(it for it in ctx["items"] if violates(it, ["辣"]))
        client = FakeClient(self.menu)
        res = recalc_plan(case["party"], ctx["items"], client,
                          [{"productCode": spicy["productCode"], "quantity": 1, "assigneeId": "m2"}])
        self.assertFalse(res["ok"])
        # 同一件辣味餐品挂到没有忌口的老周名下是允许的：忌口只约束本人
        res2 = recalc_plan(case["party"], ctx["items"], client,
                           [{"productCode": spicy["productCode"], "quantity": 1, "assigneeId": "m1"}])
        self.assertTrue(res2["ok"])

    def test_recalc_recomputes_price(self):
        case = self.cases[0]
        ctx = party_context(case["party"], [dict(it) for it in self.menu])
        safe = next(it for it in ctx["eligible"] if item_kind(it) == "main")
        client = FakeClient(self.menu)
        res = recalc_plan(case["party"], ctx["items"], client,
                          [{"productCode": safe["productCode"], "quantity": 2, "assigneeId": "m1"}])
        self.assertTrue(res["ok"])
        self.assertEqual(res["plan"]["pricing"]["totalCents"], safe["priceCents"] * 2)
        self.assertEqual(len(client.calls), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
