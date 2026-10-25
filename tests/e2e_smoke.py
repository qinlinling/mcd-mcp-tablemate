# -*- coding: utf-8 -*-
"""端到端冒烟：对着真实运行中的服务跑一遍 P0 主流程（规划 E02/E05 的联调证据）。

    python tests/e2e_smoke.py [base_url]

会真实调用麦当劳 MCP（只读），把每一步的关键事实打印出来，便于留档：
门店 → 创建聚餐 → 填心愿 → 三类方案 → 确认 → 票根 → 脱敏核对。
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8848"
DEMO = {
    "title": "周五项目庆功",
    "memberCount": 4,
    "store": {"storeCode": "1450713", "storeName": "麦当劳上海黄浦华旭国际大厦餐厅",
              "beType": 1, "orderType": 1, "beCode": None, "reservationDate": ""},
    "budgetTotal": 200,
    "members": [
        {"id": "m1", "nickname": "小北", "budget": 45, "must": ["麦辣鸡腿堡"], "nice": ["薯条"], "never": []},
        {"id": "m2", "nickname": "阿岚", "budget": 40, "must": ["鸡块"], "nice": ["玉米杯"], "never": ["辣"]},
        {"id": "m3", "nickname": "大可", "budget": 60, "must": ["巨无霸"], "nice": ["可乐"], "never": []},
        {"id": "m4", "nickname": "糖糖", "budget": 35, "must": ["麦旋风"], "nice": [], "never": ["牛肉"]},
    ],
}


def http(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode("utf-8") or "{}")


def yuan(cents):
    return "—" if cents is None else "¥%.2f" % (cents / 100)


def step(name):
    print("\n" + "=" * 68)
    print("▶ " + name)


def main():
    step("1/8 服务健康检查")
    health = http("GET", "/api/health")
    print("  MCP 可用:", health.get("ok"), "| 延迟:", health.get("latencyMs"), "ms",
          "| 数据时点:", health.get("dataTime"))
    if not health.get("ok"):
        print("  ⚠ MCP 未连通，后续步骤会走降级路径")

    step("2/8 门店查询（上海 · 人民广场）")
    stores = http("POST", "/api/stores", {"city": "上海", "keyword": "人民广场", "beType": 1})
    print("  来源:", stores.get("source"), "| 数据时点:", stores.get("dataTime"),
          "| 门店数:", len(stores.get("stores") or []))
    if stores.get("stores"):
        s = stores["stores"][0]
        print("  选中:", s["storeCode"], s["storeName"], "| 支持预约:", s.get("reservation"))

    step("3/8 创建聚餐 + 填写 4 位成员的三档心愿")
    party = http("POST", "/api/party", {k: v for k, v in DEMO.items() if k != "members"})
    if not party.get("ok"):
        print("  创建失败:", party)
        return
    pid = party["party"]["id"]
    party = http("PUT", "/api/party/" + pid, {"members": DEMO["members"]})
    print("  聚餐 id:", pid, "| 状态:", party["party"]["status"],
          "| 成员:", "、".join(m["nickname"] for m in party["party"]["members"]))
    for m in party["party"]["members"]:
        print("   -", m["nickname"], "| 必须:", m["must"] or "—",
              "| 最好有:", m["nice"] or "—", "| 不要:", m["never"] or "—",
              "| 个人预算:", m["budget"])

    step("4/8 生成三类方案（真实菜单 + 官方核价）")
    t0 = time.time()
    res = http("POST", "/api/party/%s/plans" % pid, {})
    cost = time.time() - t0
    if not res.get("ok"):
        print("  生成失败:", res.get("error"))
        return
    meta = res["meta"]
    print("  耗时: %.2fs | 数据来源: %s | 数据时点: %s" % (cost, meta["dataSource"], meta["dataTime"]))
    print("  菜单可售 %d 款；因忌口排除 %d 款（%s）"
          % (meta["eligibleCount"], meta["exclusions"]["count"],
             "、".join(meta["exclusions"]["examples"])))
    for w in meta["warnings"]:
        print("  ⚠", w)
    for plan in res["plans"]:
        p = plan["pricing"]
        print("\n  【%s】%s — %s" % (plan["name"], plan["subtitle"], plan["planId"]))
        print("    整单: %s（原价 %s，优惠 %s）| 人均 %s | 核价来源: %s"
              % (yuan(p["totalCents"]), yuan(p["originalTotalCents"]),
                 yuan(p["discountCents"]), yuan(plan["budget"]["perHeadCents"]), p["source"]))
        if p.get("coupon"):
            print("    用券:", p["coupon"].get("title"))
        for it in plan["items"]:
            owner = it["assigneeId"] or "共享"
            print("     - %-22s x%d  %s  [%s]" % (it["name"], it["quantity"], yuan(it["unitPriceCents"]), owner))
        alloc_sum = sum(a["shareCents"] for a in plan["allocation"])
        print("    分账合计 %s == 整单 %s ? %s"
              % (yuan(alloc_sum), yuan(p["totalCents"]), alloc_sum == p["totalCents"]))
        for a in plan["allocation"]:
            flag = "（超个人预算）" if a["overBudget"] else ""
            print("     %s 应付 %s%s" % (a["nickname"], yuan(a["shareCents"]), flag))
        for mid, wr in plan["wishResults"].items():
            name = next(m["nickname"] for m in party["party"]["members"] if m["id"] == mid)
            must = "；".join("%s→%s" % (x["wish"], x["status"]) for x in wr["must"]) or "—"
            nice = "；".join("%s→%s" % (x["wish"], x["status"]) for x in wr["nice"]) or "—"
            never = "；".join("%s→%s" % (x["wish"], x["status"]) for x in wr["never"]) or "—"
            print("     %s | 必须:%s | 最好有:%s | 不要:%s" % (name, must, nice, never))
        for t in plan["tradeoffs"]:
            print("     · " + t["text"])

    step("5/8 手动调整餐品后重新核价（旧价格必须作废）")
    res_all = http("GET", "/api/party/" + pid)
    base_plan = next(p for p in res_all["party"]["plans"] if p["planId"] == "B")
    rows = [{"productCode": i["productCode"], "quantity": i["quantity"], "assigneeId": i["assigneeId"]}
            for i in base_plan["items"]]
    menu = http("GET", "/api/menu?storeCode=1450713&beType=1")
    extra = next(i for i in menu["items"] if i["name"] == "可乐")
    rows.append({"productCode": extra["productCode"], "quantity": 1, "assigneeId": None})
    recalc = http("POST", "/api/party/%s/recalc" % pid, {"items": rows, "planId": "B"})
    if not recalc.get("ok"):
        print("  复算失败:", recalc.get("error"))
    else:
        new_total = recalc["plan"]["pricing"]["totalCents"]
        print("  加 1 份可乐后：整单 %s（原 %s），差值 %s"
              % (yuan(new_total), yuan(base_plan["pricing"]["totalCents"]),
                 yuan(new_total - base_plan["pricing"]["totalCents"])))
        print("  新核价时点:", recalc["plan"]["pricing"]["quotedAt"],
              "| 分账合计一致:",
              sum(a["shareCents"] for a in recalc["plan"]["allocation"]) == new_total)
    # 硬约束仍然生效：把辣味餐品挂到「不吃辣」的阿岚名下必须被拒
    spicy = next((i for i in menu["items"] if "辣" in i["name"]), None)
    bad = http("POST", "/api/party/%s/recalc" % pid,
               {"items": [{"productCode": spicy["productCode"], "quantity": 1, "assigneeId": "m2"}]})
    print("  把「%s」挂给不吃辣的阿岚 → %s"
          % (spicy["name"] if spicy else "-", "已被拒绝（符合预期）" if not bad.get("ok") else "未被拒绝（异常）"))

    step("6/8 确认方案（仅保存，不下单）")
    confirm = http("POST", "/api/party/%s/confirm" % pid, {"planId": "A"})
    print("  确认结果:", confirm.get("ok"), "|", confirm.get("notice"))
    if not confirm.get("ok"):
        print("  ", confirm.get("error"))
        return
    print("  聚餐状态:", confirm["party"]["status"])

    step("7/8 生成同桌食光票根")
    ticket = http("POST", "/api/party/%s/ticket" % pid,
                  {"visibleFields": ["title", "date", "members", "items", "wishes", "themeLine", "status"]})
    if not ticket.get("ok"):
        print("  失败:", ticket.get("error"))
        return
    t = ticket["ticket"]
    print("  状态:", t["status"], t["statusLabel"], "| 日期:", t["date"], "| 事由:", t["title"])
    print("  成员:", "、".join(t["members"]))
    print("  代表餐品:", "；".join("%s x%s（%s）" % (i["name"], i["quantity"], i["assignee"])
                                for i in t["items"]))
    print("  小心愿:", "；".join("%s 的 %s" % (w["member"], w["wish"]) for w in t["wishes"]) or "—")
    print("  主题句:", t["themeLine"])

    step("8/11 票根脱敏核对")
    raw = json.dumps(t, ensure_ascii=False)
    leaks = [k for k in ("totalCents", "shareCents", "storeName", "address", "orderId", "全部餐品金额") if k in raw]
    print("  输出中是否出现金额/门店详址/订单号字段:", "发现泄漏 %s" % leaks if leaks else "无泄漏 ✓")
    print("  默认隐藏字段:", "、".join(t["hiddenFields"]))
    step("9/11 P1：逐人授权保存偏好 → 原班人马再吃一次")
    prefs = http("POST", "/api/party/%s/preferences" % pid,
                 {"members": [{"memberId": "m1", "consent": True},
                              {"memberId": "m2", "consent": True},
                              {"memberId": "m3", "consent": False},
                              {"memberId": "m4", "consent": False}]})
    if prefs.get("ok"):
        gid = prefs["groupId"]
        print("  已保存:", "、".join(prefs["saved"]), "| 未授权（不落库）:", "、".join(prefs["skipped"]))
        groups = http("GET", "/api/preferences").get("groups") or []
        print("  偏好组列表:", [(g["nicknames"], g["wishCount"]) for g in groups])
        rv = http("POST", "/api/preferences/%s/revisit" % gid,
                  {"store": {"storeCode": "1450713", "storeName": "麦当劳上海黄浦华旭国际大厦餐厅",
                             "beType": 1, "orderType": 1, "beCode": None},
                   "budgetTotal": 150})
        if rv.get("ok"):
            p2 = rv["party"]
            named = [m["nickname"] for m in p2["members"] if m["nickname"]]
            blank = len(p2["members"]) - len(named)
            print("  再聚新聚餐:", p2["id"], "| 状态:", p2["status"],
                  "| 带入成员:", "、".join(named),
                  ("| 待填写: %d 位" % blank) if blank else "",
                  "| 旧方案数:", len(p2["plans"]), "| 数据时点:", p2["dataTime"])
            print("  说明:", rv["notice"])
        else:
            print("  再聚失败:", rv.get("error"))
    else:
        print("  保存偏好失败:", prefs.get("error"))

    step("10/11 P1：只读关联真实订单（不下单）")
    orders = http("GET", "/api/orders")
    order_id = None
    if orders.get("ok") and orders.get("orders"):
        order_id = orders["orders"][0]["orderId"]
        masked = order_id[:3] + "***" + order_id[-2:]
        print("  可关联订单 %d 条，最新：%s %s（%s）"
              % (len(orders["orders"]), masked, orders["orders"][0]["status"],
                 orders["orders"][0]["storeName"]))
        link = http("POST", "/api/party/%s/link-order" % pid, {"orderId": order_id})
        if link.get("ok"):
            diag = link["diagnostics"]
            print("  核对：门店一致=%s 时间合理=%s 餐品重合=%d 件" %
                  (diag["storeMatch"], diag["timeOk"], diag["itemOverlap"]))
            for w in diag["warnings"]:
                print("  ⚠", w)
            print("  ", link["notice"])
        else:
            print("  关联失败:", link.get("error"))
    else:
        print("  当前账号没有可关联的历史订单，跳过（不影响其他步骤）")

    step("11/11 P1：票根增强字段 + 二次脱敏复核")
    enhanced = http("POST", "/api/party/%s/ticket" % pid,
                    {"notes": {"m1": "今晚很尽兴", "m2": "下次还来"},
                     "nextMeet": "下周五同一家",
                     "visibleFields": ["title", "date", "members", "items", "wishes",
                                       "themeLine", "notes", "nextMeet", "status"]})
    if enhanced.get("ok"):
        t2 = enhanced["ticket"]
        print("  每人一句话:", "；".join("%s：%s" % (n["member"], n["note"]) for n in t2["notes"]))
        print("  下次约定:", t2["nextMeet"], "| 照片:", "有" if t2.get("photo") else "无")
        raw2 = json.dumps(t2, ensure_ascii=False)
        leak2 = [k for k in ("totalCents", "shareCents", "storeName", "orderId") if k in raw2]
        if order_id and order_id in raw2:
            leak2.append("订单号")
        print("  增强后仍无泄漏:", "✓" if not leak2 else "✗ %s" % leak2)
    else:
        print("  票根增强失败:", enhanced.get("error"))

    print("\n全流程完成。聚餐 id = %s，可在页面右上角「恢复上次聚餐」继续。" % pid)


if __name__ == "__main__":
    main()
