# -*- coding: utf-8 -*-
"""P1 功能回归：偏好授权与再聚、真实订单只读关联、票根增强字段。

覆盖的边界：
- 未授权成员的偏好一个字都不落库；一个人都没授权时拒绝保存；
- 复用只带心愿，不带个人预算、不带旧价格、不带旧门店结论；
- 订单关联只读、只做事实核对、订单号永不进入票根；
- 票根增强字段的类型/大小/成员归属校验。
"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import orders, preferences, server, store
from app.ticket import (NEXT_MEET_MAX_CHARS, PHOTO_MAX_BYTES, build_ticket,
                        sanitize_photo)


def make_party(**over):
    party = {
        "id": "p_20261025_abc123",
        "title": "周五项目庆功",
        "memberCount": 3,
        "store": {"storeCode": "1450713", "storeName": "华旭国际大厦餐厅", "beType": 1},
        "budgetTotal": 200,
        "status": "confirmed",
        "createdAt": "2026-10-25T10:00:00+08:00",
        "members": [
            {"id": "m1", "nickname": "小北", "budget": 45, "must": ["麦辣鸡腿堡"], "nice": ["薯条"], "never": []},
            {"id": "m2", "nickname": "阿岚", "budget": 40, "must": ["鸡块"], "nice": [], "never": ["辣"]},
            {"id": "m3", "nickname": "大可", "budget": 60, "must": ["巨无霸"], "nice": [], "never": []},
        ],
        "confirmedPlanId": "A",
        "confirmedPlan": {
            "planId": "A",
            "items": [{"productCode": "1440", "name": "麦辣鸡腿汉堡", "quantity": 1, "assigneeId": "m1"},
                      {"productCode": "1100", "name": "巨无霸", "quantity": 1, "assigneeId": "m3"}],
            "pricing": {"ok": True, "totalCents": 4800},
            "wishResults": {"m1": {"must": [], "nice": [], "never": []}},
        },
        "dataTime": "2026-10-25 10:05:00",
        "dataSource": "live",
    }
    party.update(over)
    return party


class FakeOrderClient:
    def __init__(self, orders_by_id=None, list_rows=None, fail=False):
        self.by_id = orders_by_id or {}
        self.rows = list_rows or []
        self.fail = fail
        self.calls = []

    def call(self, tool, args):
        self.calls.append((tool, args))
        if self.fail:
            return {"ok": False, "error": {"code": "NETWORK", "message": "断网"}, "source": "unavailable"}
        if tool == "order-list":
            return {"ok": True, "data": {"list": self.rows}, "source": "live", "dataTime": "t"}
        if tool == "query-order":
            row = self.by_id.get((args or {}).get("orderId"))
            if not row:
                return {"ok": False, "error": {"code": "600404", "message": "订单不存在"}, "source": "live"}
            return {"ok": True, "data": row, "source": "live", "dataTime": "t"}
        return {"ok": False, "error": {"code": "UNKNOWN", "message": tool}, "source": "live"}


class TestPreferencesConsent(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mmtx-pref-")
        self._orig_pref = preferences.PREF_DIR
        self._orig_party = store.PARTY_DIR
        preferences.PREF_DIR = os.path.join(self.tmp, "preferences")
        store.PARTY_DIR = os.path.join(self.tmp, "parties")
        os.makedirs(store.PARTY_DIR, exist_ok=True)

    def tearDown(self):
        preferences.PREF_DIR = self._orig_pref
        store.PARTY_DIR = self._orig_party
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_only_consented_members_are_saved(self):
        group, skipped = preferences.build_group(make_party(), [
            {"memberId": "m1", "consent": True},
            {"memberId": "m2", "consent": False},
        ])
        self.assertIsNotNone(group)
        self.assertEqual([m["nickname"] for m in group["members"]], ["小北"])
        self.assertIn("阿岚", skipped)
        self.assertIn("大可", skipped)

    def test_no_consent_returns_none(self):
        group, skipped = preferences.build_group(make_party(), [])
        self.assertIsNone(group)
        self.assertEqual(len(skipped), 3)

    def test_personal_budget_and_sensitive_fields_never_saved(self):
        group, _ = preferences.build_group(make_party(), [{"memberId": "m1", "consent": True}])
        dumped = str(group)
        for forbidden in ("budget", "45", "totalCents", "orderId", "storeCode"):
            self.assertNotIn(forbidden, dumped, f"偏好组不应包含 {forbidden}")

    def test_group_can_be_deleted(self):
        group, _ = preferences.build_group(make_party(), [{"memberId": "m1", "consent": True}])
        preferences.save_group(group)
        self.assertEqual(len(preferences.list_groups()), 1)
        self.assertTrue(preferences.delete_group(group["groupId"]))
        self.assertEqual(preferences.list_groups(), [])
        self.assertFalse(preferences.delete_group(group["groupId"]))

    def test_list_groups_returns_summary_only(self):
        group, _ = preferences.build_group(make_party(), [{"memberId": "m1", "consent": True}])
        preferences.save_group(group)
        summary = preferences.list_groups()[0]
        self.assertEqual(summary["nicknames"], ["小北"])
        self.assertEqual(summary["memberCount"], 1)
        self.assertNotIn("must", str(summary))

    def test_revisit_creates_draft_without_old_prices(self):
        group, _ = preferences.build_group(make_party(), [
            {"memberId": "m1", "consent": True}, {"memberId": "m2", "consent": True}])
        preferences.save_group(group)
        res = server.api_revisit(group["groupId"], {"store": {"storeCode": "1450713",
                                                             "storeName": "华旭"}, "budgetTotal": 150})
        self.assertTrue(res["ok"])
        party = res["party"]
        self.assertEqual(party["status"], "draft")
        self.assertEqual(party["plans"], [])
        self.assertIsNone(party["confirmedPlan"])
        self.assertIsNone(party["dataTime"])
        self.assertEqual(party["revisitOf"], group["groupId"])
        # 偏好组只有 2 人授权：补齐到 3 人下限，空位留给用户在第二步填写
        self.assertEqual([m["nickname"] for m in party["members"]], ["小北", "阿岚", ""])
        self.assertEqual(party["memberCount"], 3)
        self.assertTrue(party["needsFill"])
        self.assertEqual(party["members"][1]["never"], ["辣"])
        # 个人预算不复用
        self.assertTrue(all(m["budget"] is None for m in party["members"]))
        self.assertIn("重新核价", res["notice"])

    def test_revisit_requires_store_and_budget(self):
        group, _ = preferences.build_group(make_party(), [{"memberId": "m1", "consent": True}])
        preferences.save_group(group)
        self.assertFalse(server.api_revisit(group["groupId"], {"budgetTotal": 100})["ok"])
        self.assertFalse(server.api_revisit(group["groupId"], {"store": {"storeCode": "1"}})["ok"])
        self.assertFalse(server.api_revisit("g_not_exist", {"store": {"storeCode": "1"},
                                                          "budgetTotal": 1})["ok"])

    def test_cleanup_respects_limit_and_survives_blocked_delete(self):
        """一次删太多会被环境拦截，且拦截抛的可能不是 OSError——不能把请求带走。"""
        for i in range(5):
            g, _ = preferences.build_group(make_party(), [{"memberId": "m1", "consent": True}])
            preferences.save_group(g)
        first = preferences.cleanup(limit=2)
        self.assertEqual(first["removed"], 2)
        self.assertEqual(first["remaining"], 3)
        second = preferences.cleanup()
        self.assertEqual(second["removed"], 3)
        self.assertEqual(second["remaining"], 0)
        self.assertEqual(preferences.list_groups(), [])

    def test_cleanup_swallows_non_oserror(self):
        from unittest import mock
        g, _ = preferences.build_group(make_party(), [{"memberId": "m1", "consent": True}])
        preferences.save_group(g)
        real_remove = os.remove

        def boom(path):
            if str(path).endswith(".json"):
                raise RuntimeError("模拟环境级删除拦截")
            return real_remove(path)

        with mock.patch("app.preferences.os.remove", side_effect=boom):
            report = preferences.cleanup()
        self.assertEqual(report["removed"], 0)
        self.assertEqual(report["remaining"], 1)

    def test_save_requires_confirmed_plan(self):
        party = make_party(confirmedPlan=None, status="planned")
        res = server.api_save_preferences(party, {"members": [{"memberId": "m1", "consent": True}]})
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["code"], "NOT_CONFIRMED")

    def test_save_without_any_consent_is_rejected(self):
        res = server.api_save_preferences(make_party(), {"members": []})
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["code"], "NO_CONSENT")


class TestOrderLinking(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mmtx-order-")
        self._orig_party = store.PARTY_DIR
        store.PARTY_DIR = os.path.join(self.tmp, "parties")
        os.makedirs(store.PARTY_DIR, exist_ok=True)

    def tearDown(self):
        store.PARTY_DIR = self._orig_party
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_bad_order_id_is_rejected_before_calling_api(self):
        client = FakeOrderClient()
        res = orders.get_order(client, "../../etc/passwd")
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["code"], "BAD_ORDER_ID")
        self.assertEqual(client.calls, [], "非法订单号不应该打到官方接口")

    def test_order_list_is_sorted_and_normalized(self):
        rows = [
            {"orderId": "103000000000000019", "orderStatus": "订单已完成", "createTime": "2026-10-20 12:00:00",
             "storeCode": "1450713", "storeName": "华旭", "realTotalAmount": "48.00",
             "orderProductList": [{"productCode": "1440", "productName": "麦辣鸡腿汉堡", "quantity": 1}]},
            {"orderId": "103000000000000089", "orderStatus": "订单已完成", "createTime": "2026-10-24 18:00:00",
             "storeCode": "1450713", "storeName": "华旭", "realTotalAmount": "20.00",
             "orderProductList": []},
        ]
        res = orders.list_orders(FakeOrderClient(list_rows=rows))
        self.assertTrue(res["ok"])
        self.assertEqual([o["orderId"] for o in res["orders"]], ["103000000000000089", "103000000000000019"])
        self.assertEqual(res["orders"][0]["amountCents"], 2000)

    def test_link_order_keeps_order_id_off_ticket(self):
        row = {"orderId": "103000000000000019", "orderStatus": "订单已完成", "createTime": "2026-10-25 19:00:00",
               "storeCode": "1450713", "storeName": "华旭", "realTotalAmount": "48.00",
               "orderProductList": [{"productCode": "1440", "productName": "麦辣鸡腿汉堡", "quantity": 1}]}
        party = make_party()
        original = server.get_client
        server.get_client = lambda: FakeOrderClient(orders_by_id={"103000000000000019": row})
        try:
            res = server.api_link_order(party, {"orderId": "103000000000000019"})
        finally:
            server.get_client = original
        self.assertTrue(res["ok"])
        self.assertTrue(res["diagnostics"]["storeMatch"])
        self.assertEqual(res["diagnostics"]["itemOverlap"], 1)
        self.assertEqual(party["linkedOrder"]["orderId"], "103000000000000019")
        ticket = build_ticket(party, party["confirmedPlan"], {})
        self.assertNotIn("103000000000000019", str(ticket), "订单号绝不应该出现在票根里")

    def test_link_order_reports_mismatch_but_does_not_judge(self):
        row = {"orderId": "103000000000000777", "orderStatus": "订单已完成", "createTime": "2026-01-03 19:45:03",
               "storeCode": "1960699", "storeName": "另一家门店", "realTotalAmount": "14.90",
               "orderProductList": [{"productCode": "999", "productName": "别的餐品", "quantity": 1}]}
        party = make_party()
        original = server.get_client
        server.get_client = lambda: FakeOrderClient(orders_by_id={"103000000000000777": row})
        try:
            res = server.api_link_order(party, {"orderId": "103000000000000777"})
        finally:
            server.get_client = original
        self.assertTrue(res["ok"], "核对不通过也要允许用户自己确认，系统不替用户判真伪")
        diag = res["diagnostics"]
        self.assertFalse(diag["storeMatch"])
        self.assertFalse(diag["timeOk"])
        self.assertEqual(diag["itemOverlap"], 0)
        self.assertEqual(len(diag["warnings"]), 3)

    def test_link_order_requires_confirmed_plan(self):
        res = server.api_link_order(make_party(confirmedPlan=None), {"orderId": "103000000000000019"})
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["code"], "NOT_CONFIRMED")

    def test_link_order_surfaces_upstream_failure(self):
        party = make_party()
        original = server.get_client
        server.get_client = lambda: FakeOrderClient(fail=True)
        try:
            res = server.api_link_order(party, {"orderId": "103000000000000019"})
        finally:
            server.get_client = original
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["code"], "NETWORK")


class TestTicketEnhancements(unittest.TestCase):
    def test_photo_whitelist(self):
        ok = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
        self.assertEqual(sanitize_photo(ok), ok)
        for bad in ["https://example.com/a.jpg", "data:image/svg+xml;base64,AAA",
                    "data:text/html;base64,AAA", "", None, 123]:
            self.assertIsNone(sanitize_photo(bad), f"{bad!r} 应被拒绝")

    def test_photo_size_cap(self):
        huge = "data:image/png;base64," + "A" * (PHOTO_MAX_BYTES + 10)
        self.assertIsNone(sanitize_photo(huge))

    def test_notes_only_for_real_members(self):
        party = make_party()
        ticket = build_ticket(party, party["confirmedPlan"], {
            "notes": {"m1": "薯条最香", "m2": "下次还来", "m99": "不该出现"}})
        members = [n["member"] for n in ticket["notes"]]
        self.assertEqual(members, ["小北", "阿岚"])
        self.assertNotIn("m99", str(ticket))

    def test_note_and_next_meet_are_trimmed(self):
        party = make_party()
        long_note = "这是一句非常非常长的聚餐感想需要被截断"
        long_next = "下" * (NEXT_MEET_MAX_CHARS + 15)
        ticket = build_ticket(party, party["confirmedPlan"],
                              {"notes": {"m1": long_note}, "nextMeet": long_next})
        self.assertLessEqual(len(ticket["notes"][0]["note"]), 24)
        self.assertLessEqual(len(ticket["nextMeet"]), NEXT_MEET_MAX_CHARS)

    def test_new_fields_are_toggleable(self):
        party = make_party()
        ticket = build_ticket(party, party["confirmedPlan"], {
            "visibleFields": ["title", "members"], "notes": {"m1": "在"}, "nextMeet": "下次"})
        self.assertFalse(ticket["fieldsVisible"]["notes"])
        self.assertTrue(ticket["fieldsVisible"]["members"])
        self.assertFalse(ticket["fieldsVisible"]["photo"])

    def test_ticket_extras_are_persisted(self):
        tmp = tempfile.mkdtemp(prefix="mmtx-ticket-")
        original = store.PARTY_DIR
        store.PARTY_DIR = os.path.join(tmp, "parties")
        os.makedirs(store.PARTY_DIR, exist_ok=True)
        try:
            party = make_party()
            res = server.api_ticket(party, {"notes": {"m1": "记住了"}, "nextMeet": "下周五"})
            self.assertTrue(res["ok"])
            saved = store.get_party(party["id"])
            self.assertEqual(saved["ticketExtras"]["nextMeet"], "下周五")
            # 不带 body 再取一次，应复用已保存的增强项
            again = server.api_ticket(saved, {})
            self.assertEqual(again["ticket"]["nextMeet"], "下周五")
            self.assertEqual(again["ticket"]["notes"][0]["member"], "小北")
        finally:
            store.PARTY_DIR = original
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
