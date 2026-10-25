# -*- coding: utf-8 -*-
"""服务层容错测试（联调暴露的两个现场问题）。

1. 「商品已售罄」会让三套方案同时核价失败——必须能识别出来并刷新菜单重试；
2. 清理接口不能因为一次删太多文件而把请求线程带走（本机批量删除会被安全策略拦截）。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import server, store


class FakeClient:
    def __init__(self):
        self.dropped = []

    def invalidate(self, tool, arguments):
        self.dropped.append((tool, arguments))
        return True


class TestSoldOutDetection(unittest.TestCase):
    def test_all_plans_sold_out(self):
        plans = [{"pricing": {"ok": False, "error": {"code": "60006", "message": "商品已售罄或不可售"}}} for _ in range(3)]
        self.assertTrue(server._sold_out(plans))

    def test_message_based_detection(self):
        plans = [{"pricing": {"ok": False, "error": {"code": "99999", "message": "该商品已下架"}}}]
        self.assertTrue(server._sold_out(plans))

    def test_one_success_means_no_retry(self):
        plans = [{"pricing": {"ok": True, "error": None}}]
        self.assertFalse(server._sold_out(plans))

    def test_network_failure_is_not_sold_out(self):
        plans = [{"pricing": {"ok": False, "error": {"code": "NETWORK", "message": "连接超时"}}} for _ in range(3)]
        self.assertFalse(server._sold_out(plans), "断网应走回放/不可用路径，不要反复刷新菜单")

    def test_empty_plans(self):
        self.assertFalse(server._sold_out([]))

    def test_invalidate_menu_drops_memory_and_disk_cache(self):
        fake = FakeClient()
        original = server.get_client
        server.get_client = lambda: fake
        try:
            server._menu_cache["1450713:1:"] = (0, 999, {"ok": True})
            server.invalidate_menu("1450713", 1)
            self.assertNotIn("1450713:1:", server._menu_cache)
            self.assertEqual(fake.dropped, [("query-meals",
                                             {"storeCode": "1450713", "orderType": 1, "beType": 1})])
        finally:
            server.get_client = original


class TestCleanupSafety(unittest.TestCase):
    def test_cleanup_returns_report_and_is_bounded(self):
        report = store.cleanup("parties")
        self.assertIsInstance(report, dict)
        for key in ("removed", "failed", "remaining"):
            self.assertIn(key, report)
        self.assertLessEqual(report["removed"], store.MAX_REMOVE_PER_CALL)

    def test_single_call_never_exceeds_cap(self):
        # 上限存在的意义：一次删太多文件会触发环境的批量删除保护，请求会被直接掐断
        self.assertLess(store.MAX_REMOVE_PER_CALL, 50)


if __name__ == "__main__":
    unittest.main(verbosity=2)
