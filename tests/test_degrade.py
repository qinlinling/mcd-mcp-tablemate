# -*- coding: utf-8 -*-
"""降级路径测试（规划 §12.2：接口不可用时必须有明确反馈与可恢复路径）。

这里验证的是「不编造」这条底线：断网后要么返回带原始时点的离线回放，
要么明确报不可用，绝不允许出现凭空的商品或价格。
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.mcd_mcp import McdClient

STORE = "1450713"


class TestDegrade(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mmtx-cache-")
        self.client = McdClient(cache_dir=self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_replay_keeps_original_datatime_and_flags_source(self):
        first = self.client.query_menu(STORE)
        if not first.get("ok"):
            self.skipTest("当前环境无网络或 token 无效，跳过降级验证：%s" % first.get("error"))

        # 缓存新鲜度按文件 mtime 判定，这里把时间往前拨一天，让下一次请求真的去访问网络
        files = [f for f in os.listdir(self.tmp) if f.endswith(".json")]
        self.assertTrue(files, "应写入缓存文件")
        old = time.time() - 86400
        for name in files:
            os.utime(os.path.join(self.tmp, name), (old, old))

        # 换成必然连不通的端点，模拟现场断网
        self.client.endpoint = "http://127.0.0.1:1"
        second = self.client.query_menu(STORE)
        self.assertTrue(second.get("ok"), "有缓存时应回放而不是直接失败")
        self.assertEqual(second.get("source"), "replay")
        self.assertEqual(second.get("dataTime"), first.get("dataTime"),
                         "回放必须保留原始数据时点，不能伪装成实时")
        self.assertEqual(len(second.get("items") or []), len(first.get("items") or []))

    def test_no_cache_means_explicit_unavailable(self):
        self.client.endpoint = "http://127.0.0.1:1"
        res = self.client.calculate_price(STORE, [{"productCode": "9900005456", "quantity": 1}])
        self.assertFalse(res.get("ok"))
        self.assertEqual(res.get("source"), "unavailable")
        self.assertIsNone(res.get("totalCents"))
        self.assertTrue((res.get("error") or {}).get("message"))

    def test_business_error_is_not_treated_as_network_error(self):
        first = self.client.store_coupons(STORE)
        if not first.get("ok") or not first.get("coupons"):
            self.skipTest("当前账号没有可用券，跳过券不适用验证")
        coupon = first["coupons"][0]
        other = None
        menu = self.client.query_menu(STORE)
        for it in menu.get("items") or []:
            if it["productCode"] not in {p["productCode"] for p in coupon.get("products") or []}:
                other = it
                break
        if not other:
            self.skipTest("菜单里找不到与券无关的商品")
        res = self.client.calculate_price(STORE, [{"productCode": other["productCode"], "quantity": 1,
                                                  "couponId": coupon.get("couponId"),
                                                  "couponCode": coupon.get("couponCode")}])
        if res.get("ok"):
            self.skipTest("该券对任意商品都可用，无法构造不适用场景")
        self.assertIn(str((res.get("error") or {}).get("code")), ("600012", "600044", "PROMO"))
        self.assertEqual(res.get("source"), "live", "业务拒绝不是网络故障，不能标成 replay")


if __name__ == "__main__":
    unittest.main(verbosity=2)
