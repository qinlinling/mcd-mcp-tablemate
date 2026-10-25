# -*- coding: utf-8 -*-
"""真实订单的**只读**关联（规划 4.2 P1：标记已完成后关联真实订单）。

边界（不可越线）：
- 只调用 `order-list` / `query-order` 两个只读接口，**绝不**调用 create-order。
  作品从设计上就不替用户下单，订单必须由用户自己在麦当劳 App/小程序里完成。
- 订单号属于敏感字段：只存在本地 `.data/` 里，票根与接口的外发字段都不含它。
- 关联只做「事实核对」：门店是否一致、时间是否落在聚餐之后、餐品是否有交集。
  核对不通过不直接拒绝，而是把结论摆给用户，由用户自己确认——因为
  「跨门店/提前点好」在现实中确实存在，系统不该替用户判定真伪。
"""
from __future__ import annotations

import re
from datetime import datetime

ORDER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,40}$")
MAX_ORDERS = 10


def _parse_time(value) -> datetime | None:
    """官方时间形如 '2026-01-03 19:45:03'；解析失败返回 None（不猜）。"""
    text = str(value or "").strip().replace("T", " ")
    for fmt, size in (("%Y-%m-%d %H:%M:%S", 19), ("%Y-%m-%d %H:%M", 16), ("%Y-%m-%d", 10)):
        try:
            return datetime.strptime(text[:size], fmt)
        except ValueError:
            continue
    return None


def _normalize_order(row: dict, detail: dict | None = None) -> dict:
    """把列表项与详情合成一个稳定结构。只取展示所需字段。"""
    src = dict(row or {})
    if detail:
        src.update({k: v for k, v in detail.items() if v not in (None, "", [])})
    products = src.get("orderProductList") or (row or {}).get("orderProductList") or []
    items = []
    for p in products:
        if not isinstance(p, dict):
            continue
        items.append({
            "productCode": str(p.get("productCode") or ""),
            "name": p.get("productName") or p.get("name") or "",
            "quantity": int(p.get("quantity") or 1),
        })
    amount = src.get("realTotalAmount")
    try:
        amount_cents = int(round(float(amount) * 100)) if amount not in (None, "") else None
    except (TypeError, ValueError):
        amount_cents = None
    return {
        "orderId": str(src.get("orderId") or ""),
        "status": src.get("orderStatus") or src.get("status") or "",
        "createTime": src.get("createTime") or "",
        "storeCode": str(src.get("storeCode") or ""),
        "storeName": src.get("storeName") or "",
        "items": items,
        "amountCents": amount_cents,   # 仅用于服务端核对，不进取根
    }


def list_orders(client, limit: int = MAX_ORDERS) -> dict:
    res = client.call("order-list", {})
    if not res.get("ok"):
        return {"ok": False, "orders": [], "error": res.get("error"), "source": res.get("source")}
    rows = ((res.get("data") or {}).get("list")) or []
    orders = [_normalize_order(r) for r in rows if isinstance(r, dict)]
    orders.sort(key=lambda o: o.get("createTime") or "", reverse=True)
    return {"ok": True, "orders": orders[: max(1, int(limit))], "error": None,
            "source": res.get("source"), "dataTime": res.get("dataTime")}


def get_order(client, order_id: str) -> dict:
    if not ORDER_ID_RE.match(str(order_id or "")):
        return {"ok": False, "order": None,
                "error": {"code": "BAD_ORDER_ID", "message": "订单号格式不正确"}}
    res = client.call("query-order", {"orderId": str(order_id)})
    if not res.get("ok"):
        return {"ok": False, "order": None,
                "error": res.get("error") or {"code": "ORDER", "message": "订单查询失败"},
                "source": res.get("source")}
    data = res.get("data") if isinstance(res.get("data"), dict) else {}
    order = _normalize_order(data)
    if not order["orderId"]:
        order["orderId"] = str(order_id)
    return {"ok": True, "order": order, "error": None, "source": res.get("source")}


def diagnostics(party: dict, order: dict) -> dict:
    """把「这个订单是不是这次聚餐的」拆成可核对的三个事实，不做真伪判决。"""
    store_info = party.get("store") or {}
    plan = party.get("confirmedPlan") or {}
    plan_codes = {it.get("productCode") for it in (plan.get("items") or [])}
    order_codes = {it.get("productCode") for it in (order.get("items") or [])}
    overlap = sorted(c for c in (plan_codes & order_codes) if c)

    party_time = _parse_time(party.get("createdAt"))
    order_time = _parse_time(order.get("createTime"))
    if party_time is None or order_time is None:
        time_ok = None          # 解析不了就说不知道，不猜
    else:
        time_ok = order_time >= party_time

    return {
        "storeMatch": str(order.get("storeCode") or "") == str(store_info.get("storeCode") or ""),
        "orderStoreName": order.get("storeName") or "",
        "partyStoreName": store_info.get("storeName") or "",
        "timeOk": time_ok,
        "itemOverlap": len(overlap),
        "overlapCodes": overlap,
        "planItemCount": len(plan_codes),
        "statusCompleted": "完成" in str(order.get("status") or ""),
        "warnings": _warnings(order, store_info, time_ok, len(overlap), len(plan_codes)),
    }


def _warnings(order: dict, store_info: dict, time_ok, overlap: int, plan_count: int) -> list[str]:
    out = []
    if str(order.get("storeCode") or "") != str(store_info.get("storeCode") or ""):
        out.append("该订单来自「%s」，与本次聚餐的门店不一致" % (order.get("storeName") or "其他门店"))
    if time_ok is False:
        out.append("该订单的下单时间早于这次聚餐的创建时间，可能不是同一顿")
    if plan_count and overlap == 0:
        out.append("订单餐品与已确认方案没有任何重合，请确认是否关联错了订单")
    return out
