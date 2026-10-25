# -*- coding: utf-8 -*-
"""同源 REST 服务（标准库 ThreadingHTTPServer，无框架依赖）。

只做三件事：静态文件、参数整理、把规则层与 MCP 层串起来。
所有金额透传给前端时一律是「分」，避免两端各自换算导致对不上账。
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import orders, preferences, rules, store
from .mcd_mcp import get_client, menu_arguments
from .strategy import (attach_components, candidate_codes, generate_plans,
                       party_context, recalc_plan)
from .ticket import build_ticket

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(BASE_DIR, "web")

# 缓存值统一存成 (存入时刻, 本条有效期, 值)：失败结果的 TTL 与成功结果不同
_menu_cache: dict[str, tuple[float, float, dict]] = {}
_coupon_cache: dict[str, tuple[float, float, dict]] = {}
_detail_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
MENU_TTL = 180          # 菜单缓存只留 3 分钟：现场最容易踩的坑是「商品已售罄」而缓存里还在卖
COUPON_TTL = 300
FAIL_TTL = 5           # 失败结果只挡 5 秒：挡几分钟会把一次网络抖动变成「故障被钉死」
DETAIL_TTL = 6 * 3600  # 与适配层磁盘缓存一致
DETAIL_CACHE_MAX = 400 # 内存详情缓存条目上限，防进程长跑后无限增长
MAX_BODY = 1 << 20     # 请求体上限 1MB
# 官方核价里表示「商品已售罄 / 不可售」的错误码，命中后应丢掉菜单缓存重取一次
SOLD_OUT_CODES = {"60006", "600049", "600050"}
SOLD_OUT_WORDS = ("售罄", "不可售", "已下架", "停售")


# ---------------------------------------------------------------- 缓存

def _cached(cache: dict, key: str, ttl: int, loader):
    """带 TTL 的缓存。

    只对「成功」结果用完整 TTL；失败结果只用 FAIL_TTL 短挡一下。
    审查报告 P0-3：原来失败也存满 TTL，一次网络抖动就让菜单/券「查询失败」被钉死 3—5 分钟，
    用户看不到任何自愈路径。
    """
    now = time.time()
    with _cache_lock:
        hit = cache.get(key)
        if hit and now - hit[0] < hit[1]:
            return hit[2]
    value = loader()
    ok = not isinstance(value, dict) or value.get("ok", True)
    with _cache_lock:
        cache[key] = (now, ttl if ok else FAIL_TTL, value)
    return value


def load_menu(store_code: str, be_type: int, be_code: str | None = None) -> dict:
    key = f"{store_code}:{be_type}:{be_code or ''}"
    return _cached(_menu_cache, key, MENU_TTL,
                   lambda: get_client().query_menu(store_code, be_type, be_code))


def load_coupons(store_code: str, be_type: int, be_code: str | None = None) -> dict:
    key = f"{store_code}:{be_type}:{be_code or ''}"
    return _cached(_coupon_cache, key, COUPON_TTL,
                   lambda: get_client().store_coupons(store_code, be_type, be_code))


def dedupe_items(items: list[dict]) -> list[dict]:
    """菜单里同一商品会出现在多个分类（人气热卖 / 单人餐…），按 productCode 去重保留首个分类。"""
    seen, out = set(), []
    for it in items or []:
        code = it.get("productCode")
        if not code or code in seen:
            continue
        seen.add(code)
        out.append(it)
    return out


def _detail_key(store_code: str, be_type: int, be_code: str | None, code: str) -> str:
    """详情缓存键必须带门店与业态：同款商品在不同门店/不同业态的组成可能不同。"""
    return f"{store_code}:{be_type}:{be_code or ''}:{code}"


def _fetch_details(store_code: str, be_type: int, codes: list[str],
                   be_code: str | None = None) -> dict:
    now = time.time()
    need = []
    out: dict[str, dict] = {}
    with _cache_lock:
        for code in codes:
            hit = _detail_cache.get(_detail_key(store_code, be_type, be_code, code))
            if hit and now - hit[0] < DETAIL_TTL:
                out[code] = hit[1]
            else:
                need.append(code)
    if need:
        fetched = get_client().prefetch_details(store_code, need, be_type, be_code=be_code)
        with _cache_lock:
            for code, value in fetched.items():
                _detail_cache[_detail_key(store_code, be_type, be_code, code)] = (now, value)
            # 超上限时按插入顺序淘汰最旧的，避免进程长跑后内存无限增长
            if len(_detail_cache) > DETAIL_CACHE_MAX:
                for key in list(_detail_cache)[: len(_detail_cache) - DETAIL_CACHE_MAX]:
                    _detail_cache.pop(key, None)
        out.update(fetched)
    return {c: out[c] for c in codes if c in out}


def invalidate_menu(store_code: str, be_type: int, be_code: str | None = None) -> None:
    """丢掉某门店的菜单缓存（内存 + 适配层磁盘缓存），用于「商品已售罄」后的重取。

    失效必须与真实查询用同一套参数（`menu_arguments`）：之前这里把 orderType 写死成 1，
    外送单（orderType=2）哈希不同、删不中文件，重取链路静默失效（审查报告 P1-5）。
    """
    with _cache_lock:
        _menu_cache.pop(f"{store_code}:{be_type}:{be_code or ''}", None)
    client = get_client()
    drop = getattr(client, "invalidate", None)
    if callable(drop):
        try:
            drop("query-meals", menu_arguments(store_code, be_type, be_code))
        except Exception:  # noqa: BLE001 - 缓存失效失败不应影响主流程
            pass


def _safe_get_party(party_id: str) -> dict | None:
    """读聚餐。id 非法等价于「不存在」，不要让它变成 500。"""
    try:
        return store.get_party(party_id)
    except ValueError:
        return None


def _sold_out(plans: list[dict]) -> bool:
    """三套方案是否全部因为「商品不可售」而核价失败。"""
    if not plans or any((p.get("pricing") or {}).get("ok") for p in plans):
        return False
    for plan in plans:
        err = (plan.get("pricing") or {}).get("error") or {}
        code = str(err.get("code") or "")
        message = str(err.get("message") or "")
        if code not in SOLD_OUT_CODES and not any(w in message for w in SOLD_OUT_WORDS):
            return False
    return True


# ---------------------------------------------------------------- 并发

_party_locks: dict[str, threading.Lock] = {}
_party_lock_guard = threading.Lock()


def party_lock(party_id: str) -> threading.Lock:
    """同一聚餐一把锁：ThreadingHTTPServer 下并发写会互相覆盖（lost update）。"""
    with _party_lock_guard:
        lock = _party_locks.get(party_id)
        if lock is None:
            lock = threading.Lock()
            _party_locks[party_id] = lock
        return lock


# ---------------------------------------------------------------- 业务

def _prepare(party: dict) -> tuple[list[dict], dict]:
    """取菜单 + 补详情 + 取券，返回 (menu_items, extras)。"""
    store_info = party.get("store") or {}
    be_type = int(store_info.get("beType") or 1)
    be_code = store_info.get("beCode") or None
    store_code = store_info.get("storeCode")
    menu = load_menu(store_code, be_type, be_code)
    if not menu.get("ok"):
        raise RuntimeError("菜单查询失败：%s" % ((menu.get("error") or {}).get("message") or "未知原因"))

    items = dedupe_items(menu.get("items") or [])
    ctx = party_context(party, items)
    codes = candidate_codes(party, ctx["items"], ctx["resolution"])
    details = _fetch_details(store_code, be_type, codes, be_code)
    missing = attach_components(ctx["items"], details)
    # 详情补齐后重新解析一次心愿（现在能按套餐组成校验忌口了）
    ctx = party_context(party, ctx["items"])

    coupons_res = load_coupons(store_code, be_type, be_code)
    return ctx["items"], {"missingDetail": missing,
                          "coupons": (coupons_res.get("coupons") or []) if coupons_res.get("ok") else [],
                          "couponError": None if coupons_res.get("ok") else (coupons_res.get("error") or {}).get("message"),
                          "dataTime": menu.get("dataTime"),
                          "dataSource": menu.get("source", "live"),
                          "detailCount": len(codes),
                          "ctx": ctx}


def api_plans(party: dict, body: dict) -> dict:
    errors = rules.validate_party(party)
    if errors:
        return {"ok": False, "error": {"code": "VALIDATION", "message": errors[0]["message"],
                                       "fields": errors}}

    started = time.time()
    store_info = party.get("store") or {}
    store_code = store_info.get("storeCode")
    be_type = int(store_info.get("beType") or 1)

    items, extra = _prepare(party)
    ctx = extra["ctx"]

    party["dataTime"] = extra.get("dataTime")
    party["dataSource"] = extra.get("dataSource")

    result = generate_plans(party, ctx["items"], get_client(), resolution=ctx["resolution"],
                            coupons=extra["coupons"], missing_detail=extra["missingDetail"],
                            ctx=ctx)

    # 菜单缓存可能还留着已售罄的商品：官方核价会以「商品不可售」整单失败。
    # 这时丢掉菜单缓存重取一次，而不是直接把三张失败卡甩给用户。
    refreshed = False
    if _sold_out(result.get("plans")):
        invalidate_menu(store_code, be_type, store_info.get("beCode") or None)
        items, extra = _prepare(party)
        ctx = extra["ctx"]
        party["dataTime"] = extra.get("dataTime")
        party["dataSource"] = extra.get("dataSource")
        result = generate_plans(party, ctx["items"], get_client(), resolution=ctx["resolution"],
                                coupons=extra["coupons"], missing_detail=extra["missingDetail"],
                                ctx=ctx)
        refreshed = True

    if not result.get("plans"):
        return {"ok": False, "error": {"code": "NO_PLAN",
                                       "message": (result["meta"]["warnings"] or ["无法生成方案"])[0]}}

    meta = result["meta"]
    meta["durationMs"] = int((time.time() - started) * 1000)
    meta["detailCount"] = extra["detailCount"]
    meta["menuRefreshed"] = refreshed
    if refreshed:
        meta["warnings"].append("首次核价提示有餐品已售罄，已刷新菜单后重新核价")
    if extra.get("couponError"):
        meta["warnings"].append("优惠券查询失败：%s，本单未尝试用券" % extra["couponError"])

    party["plans"] = result["plans"]
    party["status"] = "planned"
    party["confirmedPlanId"] = None
    party["confirmedPlan"] = None
    store.save_party(party)
    return {"ok": True, "plans": result["plans"], "meta": meta, "party": party}


def api_recalc(party: dict, body: dict) -> dict:
    store_info = party.get("store") or {}
    items, extra = _prepare(party)
    ctx = extra["ctx"]
    strategy = body.get("strategy") or "balanced"
    res = recalc_plan(party, ctx["items"], get_client(), body.get("items") or [],
                      strategy=strategy, missing_detail=extra["missingDetail"],
                      plan_id=body.get("planId"))
    # 同样是「售罄」问题：刷新菜单再算一次，避免用户点了「+」只得到一条失败
    if res.get("ok") and _sold_out([res["plan"]]):
        invalidate_menu(store_info.get("storeCode"), int(store_info.get("beType") or 1),
                        store_info.get("beCode") or None)
        items, extra = _prepare(party)
        ctx = extra["ctx"]
        res = recalc_plan(party, ctx["items"], get_client(), body.get("items") or [],
                          strategy=strategy, missing_detail=extra["missingDetail"],
                          plan_id=body.get("planId"))
        if res.get("ok"):
            res["plan"]["warnings"].append("首次核价提示有餐品已售罄，已刷新菜单后重新核价")
    if not res.get("ok"):
        return res
    return {"ok": True, "plan": res["plan"], "rejected": res.get("rejected") or [],
            "dataTime": extra.get("dataTime"), "dataSource": extra.get("dataSource")}


def api_confirm(party: dict, body: dict) -> dict:
    plan_id = body.get("planId")
    plans = party.get("plans") or []
    chosen = next((p for p in plans if p.get("planId") == plan_id), None)
    if not chosen:
        return {"ok": False, "error": {"code": "NO_PLAN", "message": "找不到该方案，请重新生成方案"}}
    if not (chosen.get("pricing") or {}).get("ok"):
        return {"ok": False, "error": {"code": "PRICE_UNAVAILABLE",
                                       "message": "该方案官方核价失败，不能作为确认方案"}}
    party["confirmedPlanId"] = plan_id
    party["confirmedPlan"] = chosen
    party["status"] = "confirmed"
    party["confirmedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
    store.save_party(party)
    return {"ok": True, "party": party,
            "notice": "已保存为聚餐方案；未下单、未支付、未领券"}


# ---------------------------------------------------------------- 入参与静态路径

class ApiError(Exception):
    """可预期的客户端错误：带 HTTP 状态码，交给 handler 统一输出。"""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def as_int(value, field: str, default=None, minimum=None, maximum=None) -> int:
    """把查询串/请求体里的值转成整数，失败给「字段级」错误而不是 500。"""
    if value is None or value == "":
        if default is None:
            raise ApiError("BAD_FIELD", f"缺少参数 {field}")
        return default
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        raise ApiError("BAD_FIELD", f"{field} 需要是整数（收到 {value!r}）")
    if minimum is not None and number < minimum:
        raise ApiError("BAD_FIELD", f"{field} 不能小于 {minimum}")
    if maximum is not None and number > maximum:
        raise ApiError("BAD_FIELD", f"{field} 不能大于 {maximum}")
    return number


def resolve_static(path: str) -> str | None:
    """把 URL 路径解析成 web/ 下的真实文件；越界返回 None。

    用 realpath + commonpath 而不是 startswith：`/../web2/secret.txt` 会被归一化成
    同级的 `web2/` 目录，`startswith(WEB_DIR)` 判定为真，直接读到仓库外文件
    （审查报告 P1-1，已实测可读）。
    """
    rel = "index.html" if path in ("/", "") else path.lstrip("/")
    if rel.startswith("web/"):
        rel = rel[4:]
    root = os.path.realpath(WEB_DIR)
    target = os.path.realpath(os.path.join(root, rel))
    try:
        if os.path.commonpath([root, target]) != root:
            return None
    except ValueError:  # Windows 上跨盘符会抛 ValueError
        return None
    if not os.path.isfile(target):
        return None
    return target


def api_save_preferences(party: dict, body: dict) -> dict:
    """保存成员偏好。必须逐人授权，未授权成员一个字都不落库（规划 §11）。"""
    if not party.get("confirmedPlan"):
        return {"ok": False, "error": {"code": "NOT_CONFIRMED",
                                       "message": "请先确认一套方案，再保存这群人的口味"}}
    group, skipped = preferences.build_group(party, body.get("members") or [])
    if not group:
        return {"ok": False, "error": {"code": "NO_CONSENT",
                                       "message": "至少需要一位成员勾选同意，才能保存偏好"}}
    preferences.save_group(group)
    return {"ok": True, "groupId": group["groupId"],
            "saved": [m["nickname"] for m in group["members"]],
            "skipped": [n for n in skipped if n],
            "notice": "已保存 %d 位成员的心愿（不含个人预算）。下次可一键带入，但菜单与价格必须重新查询。"
                      % len(group["members"])}


def api_revisit(group_id: str, body: dict) -> dict:
    """原班人马，再吃一次：只回填心愿，不带旧价格、不带旧门店结论。"""
    group = preferences.get_group(group_id)
    if not group:
        return {"ok": False, "error": {"code": "NOT_FOUND", "message": "偏好组不存在或已删除"}}
    store_info = body.get("store") or {}
    if not store_info.get("storeCode"):
        return {"ok": False, "error": {"code": "BAD_FIELD",
                                       "message": "再聚也要先选门店：菜单和价格必须按当前门店重新查"}}
    budget = body.get("budgetTotal")
    if budget in (None, ""):
        return {"ok": False, "error": {"code": "BAD_FIELD", "message": "请填写这次聚餐的共同预算"}}
    party = preferences.party_from_group(group, store_info, budget, body.get("title"))
    store.save_party(party)
    return {"ok": True, "party": party,
            "notice": "已带入上次的心愿。旧价格不会沿用——请重新生成方案，按当前菜单重新核价。"}


def api_link_order(party: dict, body: dict) -> dict:
    """关联真实订单（只读核对）。绝不调用下单接口。"""
    if not party.get("confirmedPlan"):
        return {"ok": False, "error": {"code": "NOT_CONFIRMED",
                                       "message": "请先确认方案，再关联订单"}}
    order_id = (body.get("orderId") or "").strip()
    res = orders.get_order(get_client(), order_id)
    if not res.get("ok"):
        return {"ok": False, "error": res.get("error") or {"code": "ORDER",
                                                           "message": "订单查询失败"}}
    order = res["order"]
    diag = orders.diagnostics(party, order)
    party["linkedOrder"] = {
        "orderId": order["orderId"],          # 只存本地，票根与外发字段都不含
        "status": order.get("status"),
        "createTime": order.get("createTime"),
        "storeCode": order.get("storeCode"),
        "storeName": order.get("storeName"),
        **{k: diag[k] for k in ("storeMatch", "timeOk", "itemOverlap", "statusCompleted")},
        # 原文一起存：刷新后仍能展示后端给出的具体不一致原因，而不是让前端自己复述
        "warnings": diag["warnings"],
        "linkedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    store.save_party(party)
    return {"ok": True, "linkedOrder": party["linkedOrder"], "diagnostics": diag,
            "notice": "订单已关联。票根只会显示「已完成」，不会出现订单号与金额。"}


def api_ticket(party: dict, body: dict) -> dict:
    plan = party.get("confirmedPlan")
    if not plan:
        return {"ok": False, "error": {"code": "NOT_CONFIRMED",
                                       "message": "请先确认一套方案，票根只使用最终确认方案的数据"}}
    # 票根的可选增强项（照片/一句话/下次约定/字段勾选）落库，刷新页面不丢
    stored = dict(party.get("ticketExtras") or {})
    incoming = dict(body or {})
    persist = incoming.pop("persist", True)
    stored.update({k: v for k, v in incoming.items() if v is not None})
    if persist:
        party["ticketExtras"] = stored
        store.save_party(party)
    ticket = build_ticket(party, plan, stored)
    return {"ok": True, "ticket": ticket}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "MaimaiTongxi/0.1"

    def log_message(self, fmt, *args):  # 静音默认访问日志，避免终端刷屏
        pass

    # -- helpers
    def _send(self, status: int, payload: bytes, ctype: str):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _json(self, obj, status=200):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _body(self) -> dict:
        """读请求体。长度必须校验：负值会让 read() 一直等到对端关闭，线程被挂死。"""
        raw_len = self.headers.get("Content-Length")
        if raw_len in (None, ""):
            return {}
        try:
            length = int(raw_len)
        except (TypeError, ValueError):
            raise ApiError("BAD_LENGTH", "Content-Length 非法")
        if length < 0:
            raise ApiError("BAD_LENGTH", "Content-Length 不能为负数")
        if length > MAX_BODY:
            raise ApiError("BODY_TOO_LARGE", "请求体超过 1MB 上限", 413)
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8", "replace")
        try:
            data = json.loads(raw)
        except ValueError:
            raise ApiError("BAD_JSON", "请求体不是合法 JSON")
        return data if isinstance(data, dict) else {}

    def _static(self, path: str):
        target = resolve_static(path)
        if not target:
            self._json({"ok": False, "error": {"code": "NOT_FOUND", "message": "文件不存在"}}, 404)
            return
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(target, "rb") as f:
            self._send(200, f.read(), ctype)

    # -- routes
    def do_GET(self):
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        try:
            if path.startswith("/api/"):
                return self._api_get(path, query)
            return self._static(path)
        except ApiError as exc:
            self._json({"ok": False, "error": {"code": exc.code, "message": exc.message}}, exc.status)
        except Exception:  # noqa: BLE001 - 兜底，保证服务不因单个请求崩掉
            traceback.print_exc()
            self._json({"ok": False, "error": {"code": "SERVER",
                                               "message": "服务器内部错误，详见终端日志"}}, 500)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        self._handle_write("POST")

    def do_PUT(self):
        self._handle_write("PUT")

    def do_DELETE(self):
        path = urlparse(self.path).path
        try:
            m = re.match(r"^/api/preferences/([^/]+)$", path)
            if not m:
                return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                          "message": "接口不存在"}}, 404)
            try:
                removed = preferences.delete_group(m.group(1))
            except ValueError:
                removed = False
            if not removed:
                return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                          "message": "偏好组不存在或已删除"}}, 404)
            return self._json({"ok": True, "notice": "已删除该偏好组，成员口味不再被复用"})
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            self._json({"ok": False, "error": {"code": "SERVER",
                                               "message": "服务器内部错误，详见终端日志"}}, 500)

    def _handle_write(self, method: str):
        path = urlparse(self.path).path
        try:
            body = self._body()
            # 破坏性接口要求自定义请求头：跨站 fetch 无法在不触发预检的情况下带上它，
            # 从而挡住「任意网页偷偷调 localhost 清空数据」这条路（审查报告 P2-3）
            if path == "/api/cleanup" and self.headers.get("X-Mmtx-Confirm") != "1":
                raise ApiError("NEED_CONFIRM", "请在请求头带上 X-Mmtx-Confirm: 1", 403)
            return self._dispatch_write(method, path, body)
        except ApiError as exc:
            return self._json({"ok": False, "error": {"code": exc.code, "message": exc.message}},
                              exc.status)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            # 不把内部异常文本回传给浏览器（审查报告 §七 信息泄露）
            self._json({"ok": False, "error": {"code": "SERVER",
                                               "message": "服务器内部错误，详见终端日志"}}, 500)

    def _dispatch_write(self, method: str, path: str, body: dict):
        """同一聚餐的写操作串行化，避免「读出→改→写」交错互相覆盖（审查报告 P2-4）。"""
        m = re.match(r"^/api/party/([^/]+)", path)
        if not m:
            return self._api_write(method, path, body)
        party_id = m.group(1)
        try:
            store.safe_id(party_id)
        except ValueError:
            return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                      "message": "聚餐不存在"}}, 404)
        with party_lock(party_id):
            return self._api_write(method, path, body)

    def _api_get(self, path: str, query: dict):
        if path == "/api/health":
            return self._json({"ok": True, **get_client().health()})
        if path == "/api/capability":
            return self._json({"ok": True, "matrix": get_client().capability_matrix()})
        if path == "/api/menu":
            store_code = (query.get("storeCode") or [None])[0]
            if not store_code:
                raise ApiError("BAD_FIELD", "缺少 storeCode")
            be_type = as_int((query.get("beType") or ["1"])[0], "beType", 1, 1, 6)
            be_code = (query.get("beCode") or [None])[0] or None
            menu = load_menu(store_code, be_type, be_code)
            if not menu.get("ok"):
                # 上游不可用不是「参数错」：用 502 表达，而不是 200 + ok:false 混着来
                return self._json({"ok": False, "error": menu.get("error") or {"code": "MENU",
                                    "message": "菜单查询失败"}, "source": menu.get("source")}, 502)
            items = dedupe_items(menu.get("items") or [])
            return self._json({"ok": True, "storeCode": store_code, "items": items,
                               "dataTime": menu.get("dataTime"), "source": menu.get("source")})
        if path == "/api/parties":
            return self._json({"ok": True, "parties": store.list_parties()})
        if path == "/api/preferences":
            return self._json({"ok": True, "groups": preferences.list_groups()})
        if path == "/api/orders":
            res = orders.list_orders(get_client())
            payload = {"ok": bool(res.get("ok")), "orders": res.get("orders") or [],
                       "source": res.get("source")}
            if not res.get("ok"):
                payload["error"] = res.get("error") or {"code": "ORDER", "message": "订单查询失败"}
            return self._json(payload)

        m = re.match(r"^/api/party/([^/]+)$", path)
        if m:
            party = _safe_get_party(m.group(1))
            if not party:
                return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                          "message": "聚餐不存在"}}, 404)
            return self._json({"ok": True, "party": party})

        m = re.match(r"^/api/party/([^/]+)/ticket$", path)
        if m:
            party = _safe_get_party(m.group(1))
            if not party:
                return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                          "message": "聚餐不存在"}}, 404)
            return self._json(api_ticket(party, {}))

        return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                  "message": "接口不存在"}}, 404)

    def _api_write(self, method: str, path: str, body: dict):
        if path == "/api/stores":
            city = (body.get("city") or "").strip()
            keyword = (body.get("keyword") or "").strip()
            be_type = as_int(body.get("beType"), "beType", 1, 1, 6)
            if not city or not keyword:
                return self._json({"ok": False, "error": {"code": "BAD_REQUEST",
                                                          "message": "请填写城市和商圈/地标关键词"}}, 400)
            res = get_client().query_stores(city, keyword, be_type)
            payload = {"ok": bool(res.get("ok")), "stores": res.get("stores") or [],
                       "source": res.get("source"), "dataTime": res.get("dataTime")}
            if not res.get("ok"):
                payload["error"] = res.get("error") or {"code": "STORE", "message": "门店查询失败"}
            return self._json(payload)

        if path == "/api/party" and method == "POST":
            now = time.strftime("%Y-%m-%dT%H:%M:%S+08:00")
            party = {
                "id": store.new_id(),
                "title": (body.get("title") or "").strip(),
                "memberCount": as_int(body.get("memberCount"), "memberCount", 3, 1, 20),
                "store": body.get("store") or {},
                "budgetTotal": body.get("budgetTotal"),
                "status": "draft",
                "members": [],
                "confirmedPlanId": None,
                "confirmedPlan": None,
                "plans": [],
                "createdAt": now,
                "dataTime": None,
                "dataSource": "live",
            }
            members = body.get("members") or []
            if members:
                party["members"] = [rules.normalize_member(m, i + 1) for i, m in enumerate(members)]
            store.save_party(party)
            return self._json({"ok": True, "party": party})

        m = re.match(r"^/api/party/([^/]+)$", path)
        if m and method == "PUT":
            party = _safe_get_party(m.group(1))
            if not party:
                return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                          "message": "聚餐不存在"}}, 404)
            composition_changed = False
            for field in ("title", "memberCount", "store", "budgetTotal"):
                if field in body:
                    if party.get(field) != body[field]:
                        composition_changed = composition_changed or field != "title"
                    party[field] = body[field]
            if "members" in body:
                new_members = [rules.normalize_member(x, i + 1)
                               for i, x in enumerate(body.get("members") or [])]
                if new_members != party.get("members"):
                    composition_changed = True
                party["members"] = new_members
            if composition_changed and party.get("status") in ("planned", "confirmed"):
                # 规划 §12.2：改心愿或改餐品后，旧核价结果不能再被当作有效结果
                party["status"] = "draft"
                party["confirmedPlanId"] = None
                party["confirmedPlan"] = None
                party["plans"] = []
            store.save_party(party)
            return self._json({"ok": True, "party": party})

        m = re.match(r"^/api/party/([^/]+)/plans$", path)
        if m:
            party = _safe_get_party(m.group(1))
            if not party:
                return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                          "message": "聚餐不存在"}}, 404)
            return self._json(api_plans(party, body))

        m = re.match(r"^/api/party/([^/]+)/recalc$", path)
        if m:
            party = _safe_get_party(m.group(1))
            if not party:
                return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                          "message": "聚餐不存在"}}, 404)
            return self._json(api_recalc(party, body))

        m = re.match(r"^/api/party/([^/]+)/confirm$", path)
        if m:
            party = _safe_get_party(m.group(1))
            if not party:
                return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                          "message": "聚餐不存在"}}, 404)
            return self._json(api_confirm(party, body))

        m = re.match(r"^/api/party/([^/]+)/complete$", path)
        if m:
            party = _safe_get_party(m.group(1))
            if not party:
                return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                          "message": "聚餐不存在"}}, 404)
            if not party.get("confirmedPlan"):
                return self._json({"ok": False, "error": {"code": "NOT_CONFIRMED",
                                                          "message": "还没有确认方案"}}, 200)
            party["status"] = "completed" if body.get("completed") else "confirmed"
            store.save_party(party)
            return self._json({"ok": True, "party": party})

        m = re.match(r"^/api/party/([^/]+)/ticket$", path)
        if m:
            party = _safe_get_party(m.group(1))
            if not party:
                return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                          "message": "聚餐不存在"}}, 404)
            return self._json(api_ticket(party, body))

        m = re.match(r"^/api/party/([^/]+)/preferences$", path)
        if m:
            party = _safe_get_party(m.group(1))
            if not party:
                return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                          "message": "聚餐不存在"}}, 404)
            return self._json(api_save_preferences(party, body))

        m = re.match(r"^/api/preferences/([^/]+)/revisit$", path)
        if m:
            return self._json(api_revisit(m.group(1), body))

        m = re.match(r"^/api/party/([^/]+)/link-order$", path)
        if m:
            party = _safe_get_party(m.group(1))
            if not party:
                return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                          "message": "聚餐不存在"}}, 404)
            return self._json(api_link_order(party, body))

        if path == "/api/cleanup":
            scope = body.get("scope") or "parties"
            report = store.cleanup(scope)
            # 只有「全部清理」才动偏好：scope=parties 时用户只想清聚餐记录，
            # 顺手删掉他保存的口味属于越权（偏好是成员授权过的数据）
            if scope == "all":
                budget = max(0, store.MAX_REMOVE_PER_CALL - report["removed"])
                pref = preferences.cleanup(budget)
                report["removed"] += pref["removed"]
                report["remaining"] += pref["remaining"]
            with _cache_lock:
                _menu_cache.clear()
                _coupon_cache.clear()
                _detail_cache.clear()
            payload = {"ok": True, "removed": report["removed"], "scope": scope}
            left = (report.get("remaining") or 0) + (report.get("failed") or 0)
            if left:
                # 如实报告还剩多少：「单次上限」与「被系统占用」是两种原因，都要说清，
                # 只说其中一个会让用户以为已经清干净了。
                payload["remaining"] = report.get("remaining") or 0
                if report.get("failed"):
                    payload["failed"] = report["failed"]
                parts = []
                if report.get("remaining"):
                    parts.append("%d 个因单次清理上限未处理" % report["remaining"])
                if report.get("failed"):
                    parts.append("%d 个被系统占用未能删除" % report["failed"])
                payload["note"] = ("；".join(parts) + "。再点一次「清除」可继续；"
                                   "这些缓存文件也会在有效期（菜单 2 分钟 / 详情 6 小时）后自动失效。")
            return self._json(payload)

        return self._json({"ok": False, "error": {"code": "NOT_FOUND",
                                                  "message": "接口不存在"}}, 404)


def serve(host: str = "127.0.0.1", port: int = 8848):
    httpd = ThreadingHTTPServer((host, port), Handler)
    print("麦麦同席已启动： http://%s:%d" % (host, port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()
