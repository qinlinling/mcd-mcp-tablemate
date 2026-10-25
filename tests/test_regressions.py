# -*- coding: utf-8 -*-
"""针对代码审查报告（docs/后端代码审查报告.md）逐条修复的回归用例。

每条用例对应一个已确认的缺陷编号，用最小输入复现「修好之前会错、修好之后不会错」的判定。
不依赖网络：分账/忌口/缓存/路径/数量校验都是纯函数或用假核价器。
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import server, store
from app.allocate import build_allocation, check_budget, item_gross
from app.mcd_mcp import _TTL, menu_arguments
from app.rules import (expand_never, mark_flags, normalize_member, validate_party,
                       violates, yuan_to_cents)
from app.strategy import MAX_QUANTITY, generate_plans, recalc_plan

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "menu_1450713.json")


def load_menu():
    with open(FIXTURE, encoding="utf-8") as f:
        return mark_flags(json.load(f)["items"])


class FakeClient:
    """按菜单单价求和；记录每次核价的入参，便于断言「发了什么」。"""

    def __init__(self, menu, fail=False):
        self.unit = {it["productCode"]: it["priceCents"] for it in menu}
        self.calls = []
        self.fail = fail

    def calculate_price(self, store_code, items, be_type=1, reservation_date=None, be_code=None):
        self.calls.append({"store": store_code, "items": items, "be_type": be_type, "be_code": be_code})
        if self.fail:
            return {"ok": False, "error": {"code": "NETWORK", "message": "模拟失败"},
                    "source": "unavailable", "dataTime": None, "traceId": None}
        rows, total = [], 0
        for row in items:
            qty = int(row["quantity"])
            unit = self.unit.get(row["productCode"], 0)
            rows.append({"productCode": row["productCode"], "quantity": qty,
                         "subtotalCents": unit * qty})
            total += unit * qty
        return {"ok": True, "source": "official", "originalTotalCents": total,
                "totalCents": total, "discountCents": 0, "productList": rows,
                "dataTime": "2026-10-25 16:00:00", "traceId": "fake", "error": None}


class TestP0Allocation(unittest.TestCase):
    """P0-1：同码多归属时官方小计被重复计入每一行。"""

    def setUp(self):
        self.items = [
            {"productCode": "X", "quantity": 1, "unitPriceCents": 2500, "assigneeId": "m1"},
            {"productCode": "Y", "quantity": 1, "unitPriceCents": 1000, "assigneeId": "m1"},
            {"productCode": "X", "quantity": 1, "unitPriceCents": 2500, "assigneeId": "m2"},
        ]
        self.party = {"members": [{"id": "m1", "nickname": "A", "budget": None},
                                  {"id": "m2", "nickname": "B", "budget": None}]}

    def test_aggregated_productlist_is_split_by_line(self):
        pricing = {"ok": True, "totalCents": 6000,
                   "productList": [{"productCode": "X", "subtotalCents": 5000},
                                   {"productCode": "Y", "subtotalCents": 1000}]}
        self.assertEqual(item_gross(self.items, pricing), [2500, 1000, 2500])

    def test_per_line_productlist_also_works(self):
        pricing = {"ok": True, "totalCents": 6000,
                   "productList": [{"productCode": "X", "subtotalCents": 2500},
                                   {"productCode": "Y", "subtotalCents": 1000},
                                   {"productCode": "X", "subtotalCents": 2500}]}
        self.assertEqual(item_gross(self.items, pricing), [2500, 1000, 2500])

    def test_allocation_is_reproducible(self):
        pricing = {"ok": True, "totalCents": 6000,
                   "productList": [{"productCode": "X", "subtotalCents": 5000},
                                   {"productCode": "Y", "subtotalCents": 1000}]}
        alloc, _ = build_allocation(self.party, self.items, pricing)
        self.assertEqual([a["shareCents"] for a in alloc], [3500, 2500])

    def test_uneven_split_keeps_exact_total(self):
        """3 行同码、官方合并成 1 行时，拆分后之和必须仍等于官方小计。"""
        items = [{"productCode": "X", "quantity": q, "unitPriceCents": 1000, "assigneeId": f"m{i}"}
                 for i, q in enumerate([1, 2, 4])]
        party = {"members": [{"id": f"m{i}", "nickname": str(i), "budget": None} for i in range(3)]}
        pricing = {"ok": True, "totalCents": 7000,
                   "productList": [{"productCode": "X", "subtotalCents": 7000}]}
        gross = item_gross(items, pricing)
        self.assertEqual(sum(gross), 7000)
        alloc, _ = build_allocation(party, items, pricing)
        self.assertEqual(sum(a["shareCents"] for a in alloc), 7000)


class TestP0NeverVariants(unittest.TestCase):
    """P0-2：「不吃辣」「微辣」「芝士奶酪」等口语变体原本全部漏判。"""

    def test_variants_hit_spicy(self):
        for text in ["辣", "辣的", "微辣", "不吃辣", "不要辣", "别放辣椒", "麻辣的"]:
            kws, _ = expand_never([text])
            self.assertEqual(violates({"name": "麦辣鸡腿堡", "components": []}, kws), "辣",
                             f"{text} 应命中辣味")

    def test_variants_hit_beef(self):
        for text in ["牛肉", "不吃牛肉", "不要牛肉", "牛肉类"]:
            kws, _ = expand_never([text])
            self.assertIsNotNone(violates({"name": "安格斯厚牛堡", "components": []}, kws),
                                 f"{text} 应命中牛肉")

    def test_cheese_compound(self):
        kws, _ = expand_never(["芝士奶酪"])
        self.assertIsNotNone(violates({"name": "马苏里拉拉丝芝士条", "components": []}, kws))

    def test_unknown_word_is_literal_and_reported(self):
        kws, unknown = expand_never(["榴莲"])
        self.assertIn("榴莲", kws)
        self.assertEqual(unknown, ["榴莲"])

    def test_never_does_not_false_positive(self):
        kws, _ = expand_never(["牛肉"])
        self.assertIsNone(violates({"name": "麦辣鸡腿汉堡", "components": ["可乐中杯"]}, kws))


class TestP0FailureCache(unittest.TestCase):
    """P0-3：失败结果曾按完整 TTL 缓存，把一次网络抖动钉死 3—5 分钟。"""

    def test_failure_uses_short_ttl(self):
        cache = {}
        calls = {"n": 0}

        def loader():
            calls["n"] += 1
            return {"ok": False, "error": {"code": "NETWORK", "message": "x"}}

        server._cached(cache, "k", 180, loader)
        self.assertEqual(cache["k"][1], server.FAIL_TTL)
        self.assertLess(server.FAIL_TTL, 10, "失败缓存必须远短于成功 TTL，否则故障不可自愈")

    def test_success_uses_full_ttl(self):
        cache = {}
        server._cached(cache, "k", 180, lambda: {"ok": True, "items": []})
        self.assertEqual(cache["k"][1], 180)

    def test_retry_after_fail_ttl_recovers(self):
        cache = {}
        state = {"fail": True, "n": 0}

        def loader():
            state["n"] += 1
            return {"ok": not state["fail"], "items": []}

        server._cached(cache, "k", 180, loader)
        state["fail"] = False
        # 模拟 5 秒后：失败条目的有效期已过，应重新穿透 loader 拿到成功结果
        cache["k"] = (cache["k"][0] - server.FAIL_TTL - 1, cache["k"][1], cache["k"][2])
        value = server._cached(cache, "k", 180, loader)
        self.assertTrue(value["ok"])
        self.assertEqual(state["n"], 2)


class TestP1StaticTraversal(unittest.TestCase):
    """P1-1：/../web2/x 曾能读到 web/ 的同级目录。"""

    def test_sibling_directory_is_blocked(self):
        sibling = os.path.join(server.BASE_DIR, "web2")
        os.makedirs(sibling, exist_ok=True)
        secret = os.path.join(sibling, "secret.txt")
        with open(secret, "w", encoding="utf-8") as f:
            f.write("SECRET")
        try:
            self.assertIsNone(server.resolve_static("/../web2/secret.txt"))
            self.assertIsNone(server.resolve_static("/../.data/x.json"))
        finally:
            os.remove(secret)
            os.rmdir(sibling)

    def test_normal_files_still_work(self):
        self.assertTrue(server.resolve_static("/").endswith("index.html"))
        self.assertIsNotNone(server.resolve_static("/app.js"))
        self.assertIsNotNone(server.resolve_static("/web/app.js"))


class TestP1Quantity(unittest.TestCase):
    """P1-3：quantity 为负/超大时曾被原样送进官方核价。"""

    def setUp(self):
        self.menu = load_menu()
        self.party = {"title": "t", "memberCount": 3, "budgetTotal": 200,
                      "store": {"storeCode": "1450713", "beType": 1},
                      "members": [{"id": "m1", "nickname": "A", "budget": None, "must": [], "nice": [], "never": []},
                                  {"id": "m2", "nickname": "B", "budget": None, "must": [], "nice": [], "never": []},
                                  {"id": "m3", "nickname": "C", "budget": None, "must": [], "nice": [], "never": []}]}
        client = FakeClient(self.menu)
        result = generate_plans(self.party, [dict(i) for i in self.menu], client)
        self.plan = result["plans"][0]
        self.code = self.plan["items"][0]["productCode"]

    def _recalc(self, qty):
        return recalc_plan(self.party, [dict(i) for i in self.menu], FakeClient(self.menu),
                           [{"productCode": self.code, "quantity": qty, "assigneeId": "m1"}])

    def test_zero_negative_and_huge_are_rejected(self):
        for qty in [0, -5, 10 ** 9, MAX_QUANTITY + 1]:
            res = self._recalc(qty)
            self.assertFalse(res["ok"], f"quantity={qty} 应被拒绝")

    def test_valid_quantity_passes(self):
        for qty in [1, 2, MAX_QUANTITY]:
            self.assertTrue(self._recalc(qty)["ok"], f"quantity={qty} 应通过")

    def test_non_numeric_quantity_rejected(self):
        res = recalc_plan(self.party, [dict(i) for i in self.menu], FakeClient(self.menu),
                          [{"productCode": self.code, "quantity": "abc", "assigneeId": "m1"}])
        self.assertFalse(res["ok"])


class TestP1CacheKeys(unittest.TestCase):
    """P1-4 / P1-5：详情缓存键缺门店；菜单失效参数与查询参数不同源。"""

    def test_detail_key_includes_store_and_mode(self):
        a = server._detail_key("1450713", 1, None, "9900005456")
        b = server._detail_key("1450441", 1, None, "9900005456")
        c = server._detail_key("1450713", 2, "BE1", "9900005456")
        self.assertEqual(len({a, b, c}), 3)
        self.assertIn("1450713", a)

    def test_menu_arguments_match_invalidate_payload(self):
        """失效与查询必须产出同一份 arguments，否则缓存删不中。"""
        for be_type, be_code in [(1, None), (5, "B5"), (2, "B2"), (6, "B6")]:
            args = menu_arguments("1450713", be_type, be_code)
            self.assertEqual(args["orderType"], 2 if be_type in (2, 6) else 1)
            if be_type == 1:
                self.assertNotIn("beCode", args, "到店自取传 beCode 会报错")
            else:
                self.assertEqual(args["beCode"], be_code)

    def test_be_code_is_passed_to_pricing(self):
        menu = load_menu()
        party = {"title": "t", "memberCount": 3, "budgetTotal": 300,
                 "store": {"storeCode": "1450713", "beType": 5, "beCode": "BE9"},
                 "members": [{"id": f"m{i}", "nickname": str(i), "budget": None,
                              "must": ["巨无霸"], "nice": [], "never": []} for i in range(1, 4)]}
        client = FakeClient(menu)
        generate_plans(party, [dict(i) for i in menu], client)
        self.assertTrue(client.calls)
        self.assertTrue(all(c["be_code"] == "BE9" for c in client.calls))


class TestP1CouponCode(unittest.TestCase):
    """P1-6：手动复算只传 couponId，官方按 600012 拒绝。"""

    def setUp(self):
        self.menu = load_menu()
        self.party = {"title": "t", "memberCount": 3, "budgetTotal": 300,
                      "store": {"storeCode": "1450713", "beType": 1},
                      "members": [{"id": f"m{i}", "nickname": str(i), "budget": None,
                                   "must": [], "nice": [], "never": []} for i in range(1, 4)]}
        self.code = self.menu[0]["productCode"]

    def test_coupon_id_and_code_sent_together(self):
        client = FakeClient(self.menu)
        recalc_plan(self.party, [dict(i) for i in self.menu], client,
                    [{"productCode": self.code, "quantity": 1, "assigneeId": "m1",
                      "couponId": "CID", "couponCode": "CCODE"}])
        row = client.calls[-1]["items"][0]
        self.assertEqual(row.get("couponId"), "CID")
        self.assertEqual(row.get("couponCode"), "CCODE")

    def test_missing_coupon_code_is_reported_not_silent(self):
        client = FakeClient(self.menu)
        res = recalc_plan(self.party, [dict(i) for i in self.menu], client,
                          [{"productCode": self.code, "quantity": 1, "assigneeId": "m1",
                            "couponId": "CID"}])
        self.assertTrue(res["ok"])
        self.assertNotIn("couponId", client.calls[-1]["items"][0])
        self.assertTrue(any("couponCode" in w for w in res["plan"]["warnings"]))


class TestP2Misc(unittest.TestCase):
    """P2-7 新品误判 / P2-8 元→分口径 / P2-9 无价商品静默丢弃。"""

    def test_single_char_novelty_no_longer_matches(self):
        for name in ["草莓新地", "新西兰风味汉堡"]:
            self.assertFalse(mark_flags([{"productCode": "x", "name": name, "tags": []}])[0]["novelty"],
                             f"{name} 不该被判成新品")
        self.assertTrue(mark_flags([{"productCode": "y", "name": "新品芝士条", "tags": []}])[0]["novelty"])

    def test_yuan_to_cents_matches_decimal_rounding(self):
        self.assertEqual(yuan_to_cents("1.005"), 101)
        self.assertEqual(yuan_to_cents("0.145"), 15)
        self.assertEqual(yuan_to_cents("33.5"), 3350)
        self.assertIsNone(yuan_to_cents(""))

    def test_budget_uses_same_rounding(self):
        info = check_budget({"budgetTotal": 1.005}, 101)
        self.assertEqual(info["budgetCents"], 101)

    def test_items_without_price_are_reported(self):
        menu = load_menu()
        broken = [dict(menu[0]), dict(menu[1])]
        broken[0]["priceCents"] = 0
        party = {"title": "t", "memberCount": 3, "budgetTotal": 300,
                 "store": {"storeCode": "1450713", "beType": 1},
                 "members": [{"id": f"m{i}", "nickname": str(i), "budget": None,
                              "must": [], "nice": [], "never": []} for i in range(1, 4)]}
        result = generate_plans(party, broken, FakeClient(menu))
        self.assertTrue(any("未取到官方价格" in w for w in result["meta"]["warnings"]))


class TestInputHardening(unittest.TestCase):
    """P2-2 / P2-5 / P2-6：入参与 id 的错误码不再一律 500。"""

    def test_as_int_reports_field_errors(self):
        self.assertEqual(server.as_int("3", "n"), 3)
        self.assertEqual(server.as_int(None, "n", 5), 5)
        for bad in ["abc", "1.5", "  ", None]:
            with self.assertRaises(server.ApiError) as ctx:
                server.as_int(bad, "beType", None)
            self.assertEqual(ctx.exception.status, 400)
            self.assertIn("beType", ctx.exception.message)

    def test_as_int_bounds(self):
        with self.assertRaises(server.ApiError):
            server.as_int("9", "memberCount", 3, 1, 8)

    def test_invalid_party_id_maps_to_not_found(self):
        self.assertIsNone(server._safe_get_party("../../etc/passwd"))
        self.assertIsNone(server._safe_get_party("p_不存在"))

    def test_normalize_member_no_longer_silent_truncates(self):
        member = normalize_member({"nickname": "A", "must": ["a", "b", "c", "d"]}, 1)
        self.assertEqual(len(member["must"]), 4, "不应静默丢弃超限心愿")
        party = {"title": "t", "memberCount": 3, "budgetTotal": 100,
                 "store": {"storeCode": "1", "beType": 1},
                 "members": [dict(member, id=f"m{i}") for i in range(1, 4)]}
        errors = validate_party(party)
        self.assertTrue(any("最多" in e["message"] for e in errors), "应由校验显式报错")


if __name__ == "__main__":
    unittest.main(verbosity=2)
