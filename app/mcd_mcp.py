# -*- coding: utf-8 -*-
"""麦当劳 MCP 适配层：JSON-RPC 直连 + 本地缓存 + 降级回放。

设计取舍（为什么这么做）：
- 只用标准库：项目要求「新环境零依赖可复现」，与仓库既有 mcd-mcp/mcd.py 保持一致。
- 金额一律存「分」int：官方两个接口单位不一致（菜单是元字符串、核价是分），
  在唯一入口处换算，上层永远不用关心单位，也不会出现 33.5*3 的浮点尾差。
- 任何失败都转成 dict 而不是抛异常：上层是 REST 服务，异常会直接把 500 抛给前端；
  这里把「业务失败 / 网络失败 / 解析失败」三种语义分开，前端才能区分展示。
- 绝不返回编造的价格：网络异常时只允许回放真实历史缓存，否则明确 unavailable。
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

DEFAULT_ENDPOINT = "https://mcp.mcd.cn"
DEFAULT_TIMEOUT = 30

# 缓存有效期（秒）。0 表示不缓存：核价必须实时，否则用户改数量还看到旧价。
_TTL = {
    "query-nearby-stores": 300,
    # 菜单变动快：缓存里的商品一旦下架，官方核价会整单报「60006 商品已售罄」，
    # 三套方案同时核价失败。宁可多查一次，也不要在演示现场连着出三张失败卡。
    "query-meals": 120,
    "query-meal-detail": 21600,  # 套餐组成几乎不变，且单条 0.4s，值得长缓存
    "query-store-coupons": 300,
    "calculate-price": 0,
    "now-time-info": 0,
    "query-my-account": 0,
}

# 新品判定的关键词。官方没有 novelty 字段，只能靠标签/名称推断。
# 必须都是多字词：单字「新」会把「草莓新地」「新西兰风味」误判成新品，
# 进而让「一起尝点新」把常规甜品当尝鲜项推荐出去（审查报告 P2-7）。
_NOVELTY_WORDS = ("上新", "限时", "新品", "回归", "新口味")
_COMBO_WORDS = ("套餐", "件套", "组合", "随心配")


class _NetworkError(Exception):
    """连接层失败（DNS/超时/HTTP 状态码），可回放历史缓存。"""


class _ParseError(Exception):
    """拿到了响应但不是可解析的工具结果，同样只允许回放，不允许猜。"""


# ---------------------------------------------------------------- 解析工具


def _extract_json(text: str) -> dict | None:
    """从工具返回文本中挖出真正的 JSON 对象。

    工具返回体前面会拼一大段 markdown 字段说明（表格里也有花括号），
    直接 json.loads 必然失败。所以先按最可能的锚点 '{"success"' / '{"code"' 找起点，
    再退化为逐字符找 '{'，每个起点都用 raw_decode 试一次——只有能完整解码成 dict。
    """
    if not isinstance(text, str) or not text.strip():
        return None
    decoder = json.JSONDecoder(strict=False)  # strict=False：容忍说明文本里的裸控制字符

    positions: list[int] = []
    for marker in ('{"success"', '{"code"'):
        idx = text.find(marker)
        while idx != -1:
            positions.append(idx)
            idx = text.find(marker, idx + 1)
    idx = text.find("{")
    while idx != -1:
        positions.append(idx)
        idx = text.find("{", idx + 1)

    fallback: dict | None = None
    for pos in positions:
        try:
            obj, _ = decoder.raw_decode(text, pos)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        if "success" in obj:  # 官方工具响应的唯一稳定特征
            return obj
        if fallback is None and ("data" in obj or "code" in obj):
            fallback = obj
    return fallback


def _decode_response(raw: str) -> dict | None:
    """解析 JSON-RPC 响应体，兼容 SSE 包装。"""
    text = (raw or "").strip()
    if text.startswith("event:") or text.startswith("data:"):
        frames = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
        for frame in frames:  # 正常只有一帧，多帧时逐个试，避免半包直接判死
            if not frame or frame == "[DONE]":
                continue
            try:
                return json.loads(frame)
            except ValueError:
                continue
        try:  # 极少数情况下 JSON 被拆成多行 data:
            return json.loads("".join(frames))
        except ValueError:
            return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _yuan_to_cents(value) -> int:
    """「元」→「分」。

    菜单接口的 currentPrice/originalPrice 是元字符串（如 "33.5"，也可能为空串），
    内部统一用分；用 Decimal 而不是 float，避免 46.9*100 = 4689.999... 之类的尾差。
    """
    if value is None:
        return 0
    text = str(value).strip()
    if not text:
        return 0
    try:
        return int((Decimal(text) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError):
        return 0


def _as_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _order_type(be_type: int) -> int:
    """beType → orderType：到店自取/得来速都属于「到店」单，外送/团餐属于外送单。"""
    return 1 if _as_int(be_type, 1) in (1, 5) else 2


def menu_arguments(store_code: str, be_type: int = 1, be_code: str | None = None) -> dict:
    """query-meals 的完整入参。

    公开出来是为了让「失效缓存」和「真实查询」用同一套参数：
    之前 server 失效时把 orderType 硬编码成 1，外送（orderType=2）删不中缓存，
    售罄后的重取链路直接失效（审查报告 P1-5）。
    beCode 只在这三种业态下传，到店自取传了反而报错（能力矩阵实测结论）。
    """
    bt = _as_int(be_type, 1)
    args: dict = {"storeCode": store_code, "orderType": _order_type(bt), "beType": bt}
    if bt in (2, 5, 6) and be_code:
        args["beCode"] = be_code
    return args


def _category_name(name) -> str:
    """分类名里带换行（如 "小食拼盘\\n/多人餐"），压成单斜杠便于前端一行展示。"""
    parts = [p.strip() for p in str(name or "").splitlines()]
    text = "/".join(p for p in parts if p and p != "/")
    text = text or str(name or "").strip()
    while "//" in text:
        text = text.replace("//", "/")
    return text


def _normalize_menu(data: dict) -> list[dict]:
    """把 query-meals 的 categories+meals 两张表合成 MenuItem 列表。

    categories 只给 code/tags，商品主体在 data.meals（dict，key=productCode）。
    分类归属只能反向从 categories 里查，所以同一商品在多分类出现时取第一个。
    """
    meals_raw = data.get("meals") if isinstance(data, dict) else None
    if not isinstance(meals_raw, dict):
        meals_raw = {}
    items: list[dict] = []
    seen: set[str] = set()

    for category in data.get("categories") or []:
        if not isinstance(category, dict):
            continue
        cat_name = _category_name(category.get("name"))
        for entry in category.get("meals") or []:
            if not isinstance(entry, dict):
                continue
            code = str(entry.get("code") or "").strip()
            if not code or code in seen:
                continue
            meal = meals_raw.get(code)
            if not isinstance(meal, dict):  # 菜单表里没有实体就没有名称/价格，宁可丢弃也不编造
                continue
            seen.add(code)
            name = str(meal.get("name") or "").strip()
            tags = [str(t).strip() for t in (entry.get("tags") or []) if str(t).strip()]
            novelty = any(word in tag for tag in tags for word in _NOVELTY_WORDS) or any(
                word in name for word in _NOVELTY_WORDS
            )
            items.append(
                {
                    "productCode": code,
                    "name": name,
                    "category": cat_name,
                    # 元→分在这里发生，scale 见 _yuan_to_cents
                    "priceCents": _yuan_to_cents(meal.get("currentPrice")),
                    "originalPriceCents": _yuan_to_cents(meal.get("originalPrice")),
                    "image": meal.get("image") or "",
                    "tags": tags,
                    "novelty": novelty,
                    "combo": any(word in name for word in _COMBO_WORDS),
                    "components": [],  # 详情另取，避免菜单接口 116 次额外请求
                }
            )
    return items


def _components_from_detail(data: dict) -> tuple[list[str], bool]:
    """从 rounds[].choices[] 提取套餐组成 + 是否可特制。

    每个 round 代表「选一个小食/一杯饮料」这类槽位，取默认项（isDefault==1）才是
    用户实际会拿到的组合；没有默认项时退化为 quantity>0 的第一项。
    """
    names: list[str] = []
    support_modify = bool(data.get("supportModify")) if isinstance(data, dict) else False
    for round_ in (data.get("rounds") or []) if isinstance(data, dict) else []:
        if not isinstance(round_, dict):
            continue
        choices = [c for c in (round_.get("choices") or []) if isinstance(c, dict)]
        picked = next((c for c in choices if _as_int(c.get("isDefault")) == 1), None)
        if picked is None:
            picked = next((c for c in choices if _as_int(c.get("quantity")) > 0), None)
        if picked is not None:
            name = str(picked.get("name") or "").strip()
            if name and name not in names:
                names.append(name)
        if any(c.get("supportModify") for c in choices):
            support_modify = True
    return names, support_modify


# ---------------------------------------------------------------- 客户端


class McdClient:
    def __init__(
        self,
        token: str | None = None,
        endpoint: str = DEFAULT_ENDPOINT,
        cache_dir: str | None = None,
    ) -> None:
        self.endpoint = endpoint or DEFAULT_ENDPOINT
        self.timeout = DEFAULT_TIMEOUT
        self.cache_dir = cache_dir or os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".cache", "mcd"
        )
        self._token, self._token_error = _load_token(token)
        # 健康探针结果缓存 60s：前端每次刷新都会打 /api/health，
        # 两个 TTL=0 的官方调用没必要跟着刷（审查报告 P3-13）
        self._health_memo: tuple[float, dict] | None = None
        self.health_ttl = 60

    # ------------------------------------------------------------ 底层

    def call(self, tool: str, arguments: dict) -> dict:
        """底层 JSON-RPC 调用。永不抛异常，失败语义写在 source / error 里。"""
        args = dict(arguments or {})
        cache_path = self._cache_path(tool, args)
        ttl = _TTL.get(tool, 0)

        if ttl > 0:
            cached = self._read_cache(cache_path, max_age=ttl)
            if cached is not None:
                # 命中缓存仍算 live：数据确由官方返回，只是时点是缓存里的原始时点
                return cached

        if not self._token:
            return self._degrade(cache_path, "CONFIG", self._token_error or "未找到 token")

        try:
            response = self._rpc("tools/call", {"name": tool, "arguments": args})
        except _NetworkError as exc:
            return self._degrade(cache_path, "NETWORK", str(exc))
        except _ParseError as exc:
            return self._degrade(cache_path, "PARSE", str(exc))

        if "error" in response:  # JSON-RPC 协议级错误（非业务失败）
            err = response.get("error") or {}
            return {
                "ok": False,
                "data": None,
                "error": {
                    "code": str(err.get("code", "RPC")),
                    "message": err.get("message") or "MCP 协议返回错误",
                },
                "traceId": None,
                "dataTime": None,
                "source": "live",
            }

        result = response.get("result") or {}
        content = result.get("content") or []
        text = "\n".join(c.get("text", "") for c in content if isinstance(c, dict))
        body = _extract_json(text)
        if body is None and isinstance(result.get("structuredContent"), dict):
            structured = result["structuredContent"]
            if "success" in structured:
                body = structured
        if body is None:
            return self._degrade(cache_path, "PARSE", "工具返回体中未找到可解析的 JSON")

        data_time = body.get("datetime") or None
        trace_id = body.get("traceId") or None
        ok = bool(body.get("success"))

        if not ok:
            # 业务失败（如券不适用 600012）是「接口正常工作」的结论，source 保持 live
            return {
                "ok": False,
                "data": None,
                "error": {
                    "code": str(body.get("code")) if body.get("code") is not None else "BIZ",
                    "message": body.get("message") or "接口返回 success=false",
                },
                "traceId": trace_id,
                "dataTime": data_time,
                "source": "live",
            }

        result_dict = {
            "ok": True,
            "data": body.get("data"),
            "error": None,
            "traceId": trace_id,
            "dataTime": data_time,
            "source": "live",
        }
        if ttl > 0:
            self._write_cache(cache_path, result_dict)
        return result_dict

    def _rpc(self, method: str, params: dict) -> dict:
        body = json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, ensure_ascii=False
        ).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                # 服务端严格要求「Bearer + 单空格 + 原始 token」，大小写也不能改
                "Authorization": "Bearer " + self._token,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:200]
            except Exception:
                pass
            raise _NetworkError("HTTP %s %s" % (exc.code, detail or exc.reason)) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            raise _NetworkError("网络异常：%s" % (reason,)) from exc

        payload = _decode_response(raw)
        if not isinstance(payload, dict):
            raise _ParseError("响应不是合法 JSON")
        return payload

    # ------------------------------------------------------------ 缓存

    def _cache_path(self, tool: str, args: dict) -> str:
        # 参数排序后哈希：同一组参数必须落同一个文件，否则缓存不命中
        digest = hashlib.sha1(
            json.dumps({"tool": tool, "args": args}, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()[:16]
        return os.path.join(self.cache_dir, "%s_%s.json" % (tool, digest))

    def invalidate(self, tool: str, arguments: dict) -> bool:
        """删掉某个调用的磁盘缓存，用于「商品已售罄」后强制重取。

        返回是否真的删掉了文件；文件不存在或删不掉都返回 False，绝不抛异常——
        缓存失效失败只能让数据变旧，不该让主流程崩掉。
        """
        path = self._cache_path(tool, dict(arguments or {}))
        try:
            os.remove(path)
            return True
        except OSError:
            return False

    def _read_cache(self, path: str, max_age: float | None = None) -> dict | None:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            result = payload.get("result")
            if not isinstance(result, dict) or "ok" not in result:
                return None
            if max_age is not None and (time.time() - os.path.getmtime(path)) > max_age:
                return None
            return result
        except (OSError, ValueError):
            return None

    def _write_cache(self, path: str, result: dict) -> None:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            payload = {
                "storedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
                "result": result,
            }
            # 唯一临时名：并发预取同一商品时，固定 ".tmp" 会让第二个写者直接 OSError
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-", suffix=".json")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle, ensure_ascii=False)
                os.replace(tmp, path)  # 原子替换，并发读不会读到半截文件
            except OSError:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                raise
        except OSError:
            pass  # 缓存是加速手段，写不进去不影响主流程

    def _degrade(self, cache_path: str, code: str, message: str) -> dict:
        """网络/解析失败时的唯一合法退路：回放真实历史缓存，否则明确不可用。"""
        cached = self._read_cache(cache_path, max_age=None)  # 过期也回放，但必须保留原始 dataTime
        if cached is not None:
            replay = dict(cached)
            replay["source"] = "replay"
            return replay
        return {
            "ok": False,
            "data": None,
            "error": {"code": code, "message": message},
            "traceId": None,
            "dataTime": None,
            "source": "unavailable",
        }

    # ------------------------------------------------------------ 健康

    def health(self, force: bool = False) -> dict:
        if not force and self._health_memo and time.time() - self._health_memo[0] < self.health_ttl:
            return dict(self._health_memo[1])
        payload = self._probe_health()
        self._health_memo = (time.time(), payload)
        return dict(payload)

    def _probe_health(self) -> dict:
        try:
            started = time.perf_counter()
            result = self.call("now-time-info", {})
            latency_ms = int(round((time.perf_counter() - started) * 1000))
        except Exception as exc:  # health 是探针，任何异常都不能击穿 /api/health
            return {"ok": False, "latencyMs": 0, "dataTime": None, "accountHint": None,
                    "error": {"code": "INTERNAL", "message": str(exc)}}
        data_time = result.get("dataTime")
        if result.get("ok") and isinstance(result.get("data"), dict):
            data_time = result["data"].get("formatted") or data_time
        return {
            "ok": bool(result.get("ok")),
            "latencyMs": latency_ms,
            "dataTime": data_time,
            "accountHint": self._account_hint(),
        }

    def _account_hint(self) -> dict | None:
        """只取积分/等级这类「证明凭证有效」的字段，绝不外泄 accountId。"""
        try:
            result = self.call("query-my-account", {})
        except Exception:
            return None
        if not result.get("ok") or not isinstance(result.get("data"), dict):
            return None
        data = result["data"]
        hint = {
            "availablePoint": data.get("availablePoint"),
            "accumulativePoint": data.get("accumulativePoint"),
            "currency": data.get("currency"),
            "level": data.get("level") or data.get("memberLevel"),
        }
        return hint if any(v for v in hint.values()) else None

    # ------------------------------------------------------------ 业务方法

    def query_stores(self, city: str, keyword: str, be_type: int = 1) -> dict:
        result = self.call(
            "query-nearby-stores",
            {"city": city, "keyword": keyword, "beType": be_type, "searchType": 2},
        )
        if not result["ok"]:
            return {"ok": False, "stores": [], "error": result["error"],
                    "source": result["source"], "dataTime": result["dataTime"]}
        rows = result["data"] if isinstance(result["data"], list) else []
        stores = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            stores.append(
                {
                    "storeCode": str(row.get("storeCode") or ""),
                    "storeName": row.get("storeName") or "",
                    "address": row.get("address") or "",
                    "distance": row.get("distance"),
                    "reservation": bool(row.get("reservation")),
                    "beCode": row.get("beCode"),
                }
            )
        return {"ok": True, "stores": stores, "error": None,
                "source": result["source"], "dataTime": result["dataTime"]}

    def query_menu(self, store_code: str, be_type: int = 1, be_code: str | None = None) -> dict:
        result = self.call("query-meals", menu_arguments(store_code, be_type, be_code))
        if not result["ok"]:
            return {"ok": False, "items": [], "error": result["error"],
                    "source": result["source"], "dataTime": result["dataTime"],
                    "traceId": result["traceId"]}
        items = _normalize_menu(result["data"] if isinstance(result["data"], dict) else {})
        return {"ok": True, "items": items, "error": None,
                "source": result["source"], "dataTime": result["dataTime"],
                "traceId": result["traceId"]}

    def meal_detail(self, store_code: str, code: str, be_type: int = 1,
                    be_code: str | None = None) -> dict:
        args = menu_arguments(store_code, be_type, be_code)
        args["code"] = code
        result = self.call("query-meal-detail", args)
        if not result["ok"]:
            return {"ok": False, "detail": None, "components": [], "supportModify": False,
                    "error": result["error"], "source": result["source"]}
        detail = result["data"] if isinstance(result["data"], dict) else {}
        components, support_modify = _components_from_detail(detail)
        return {"ok": True, "detail": detail, "components": components,
                "supportModify": support_modify, "error": None, "source": result["source"]}

    def prefetch_details(
        self, store_code: str, codes: list[str], be_type: int = 1, workers: int = 8,
        be_code: str | None = None,
    ) -> dict[str, dict]:
        # 单条约 0.4s，116 项串行要 45s；8 路并发 + 6h 缓存把这一步压到可接受范围
        unique = [c for c in dict.fromkeys(codes or []) if c]
        if not unique:
            return {}
        results: dict[str, dict] = {}
        pool_size = max(1, min(_as_int(workers, 8) or 8, len(unique)))
        with ThreadPoolExecutor(max_workers=pool_size) as pool:
            futures = {
                pool.submit(self.meal_detail, store_code, code, be_type, be_code): code for code in unique
            }
            for future in as_completed(futures):
                code = futures[future]
                try:
                    results[code] = future.result()
                except Exception as exc:  # 单条失败不能拖垮整批
                    results[code] = {
                        "ok": False, "detail": None, "components": [], "supportModify": False,
                        "error": {"code": "INTERNAL", "message": str(exc)},
                        "source": "unavailable",
                    }
        return {code: results[code] for code in unique if code in results}  # 保持入参顺序

    def store_coupons(self, store_code: str, be_type: int = 1, be_code: str | None = None) -> dict:
        result = self.call("query-store-coupons", menu_arguments(store_code, be_type, be_code))
        if not result["ok"]:
            return {"ok": False, "coupons": [], "error": result["error"],
                    "source": result["source"], "dataTime": result["dataTime"]}
        rows = result["data"] if isinstance(result["data"], list) else []
        coupons = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            products = [
                {
                    "productCode": str(p.get("productCode") or ""),
                    "productName": p.get("productName") or "",
                }
                for p in (row.get("products") or [])
                if isinstance(p, dict)
            ]
            coupons.append(
                {
                    "couponId": row.get("couponId"),
                    "couponCode": row.get("couponCode"),
                    "title": row.get("title") or "",
                    "tradeDateTime": row.get("tradeDateTime") or "",
                    "products": products,
                }
            )
        return {"ok": True, "coupons": coupons, "error": None,
                "source": result["source"], "dataTime": result["dataTime"]}

    def calculate_price(
        self,
        store_code: str,
        items: list[dict],
        be_type: int = 1,
        reservation_date: str | None = None,
        be_code: str | None = None,
    ) -> dict:
        arguments: dict = menu_arguments(store_code, be_type, be_code)
        arguments["items"] = items or []
        if reservation_date:  # 预约场景官方要求必传，非预约传了反而报错
            arguments["reservationDate"] = reservation_date

        result = self.call("calculate-price", arguments)
        if not result["ok"]:
            return {
                "ok": False,
                "originalTotalCents": None,
                "totalCents": None,
                "discountCents": None,
                "productList": [],
                "error": result["error"],
                "traceId": result["traceId"],
                "dataTime": result["dataTime"],
                "source": result["source"],
            }

        data = result["data"] if isinstance(result["data"], dict) else {}
        product_list = []
        for row in data.get("productList") or []:
            if not isinstance(row, dict):
                continue
            product_list.append(
                {
                    "productCode": str(row.get("productCode") or ""),
                    "productName": row.get("productName") or "",
                    "quantity": _as_int(row.get("quantity"), 0),
                    # 核价接口返回的就是「分」，这里绝不二次 ×100
                    "subtotalCents": _as_int(row.get("subtotal"), 0),
                    "originalSubtotalCents": _as_int(row.get("originalSubtotal"), 0),
                }
            )
        return {
            "ok": True,
            "originalTotalCents": _as_int(data.get("originalPrice"), 0),
            "totalCents": _as_int(data.get("price"), 0),
            "discountCents": _as_int(data.get("discount"), 0),
            "productList": product_list,
            "error": None,
            "traceId": result["traceId"],
            "dataTime": result["dataTime"],
            "source": result["source"],
        }

    # ------------------------------------------------------------ 能力矩阵

    def capability_matrix(self) -> dict:
        return {
            "probedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "endpoint": self.endpoint,
            "tools": [
                {
                    "name": "query-nearby-stores",
                    "purpose": "按城市+关键词找门店，拿到 storeCode 与可预约时段",
                    "used": True,
                    "params": {"beType": "1|5", "searchType": 2, "city": "城市名", "keyword": "商圈/地标"},
                    "notes": "searchType=2 才按位置搜索；默认 1 是搜收藏餐厅",
                },
                {
                    "name": "query-meals",
                    "purpose": "取门店可售菜单（分类 + 商品价格/图片/标签）",
                    "used": True,
                    "params": {"storeCode": "门店编码", "orderType": 1, "beType": 1},
                    "notes": "data.categories 是展示顺序，data.meals 是以 productCode 为 key 的字典",
                },
                {
                    "name": "query-meal-detail",
                    "purpose": "取套餐组成与可特制项，用于忌口校验",
                    "used": True,
                    "params": {"storeCode": "门店编码", "code": "productCode", "orderType": 1, "beType": 1},
                    "notes": "单次约 0.4s，必须并发预取 + 长缓存",
                },
                {
                    "name": "query-store-coupons",
                    "purpose": "取门店可用券及其适用商品",
                    "used": True,
                    "params": {"storeCode": "门店编码", "orderType": 1, "beType": 1},
                    "notes": "同一 couponId 可能对应多张券码",
                },
                {
                    "name": "calculate-price",
                    "purpose": "官方核价，返回原价/实付/优惠/逐项小计",
                    "used": True,
                    "params": {"storeCode": "门店编码", "orderType": 1, "beType": 1,
                               "items": [{"productCode": "", "quantity": 1, "couponId": "可选", "couponCode": "可选"}],
                               "reservationDate": "预约时必传，格式 yyyy-MM-dd HH:mm"},
                    "notes": "金额单位是分；productCode+quantity 即可核价，无需 roundList",
                },
                {
                    "name": "now-time-info",
                    "purpose": "官方服务器时间，用于健康探测与数据时点对齐",
                    "used": True,
                    "params": {},
                    "notes": "无参数，约 0.2-0.5s",
                },
                {
                    "name": "query-my-account",
                    "purpose": "读会员积分，作为「凭证有效」的旁证",
                    "used": True,
                    "params": {},
                    "notes": "只取积分字段，accountId 不外传",
                },
            ],
            "fields": [
                {"tool": "query-meals", "field": "data.categories[].meals[].code",
                 "available": True, "note": "只给 code 与 tags，商品主体要去 data.meals 查"},
                {"tool": "query-meals", "field": "data.meals{code}.currentPrice",
                 "available": True, "note": "元字符串（如 \"33.5\"），可能为空串，适配层×100 转分"},
                {"tool": "query-meals", "field": "data.meals{code}.originalPrice",
                 "available": True, "note": "元字符串，同上"},
                {"tool": "query-meals", "field": "套餐组成 / 单品的规格",
                 "available": False, "note": "菜单接口不返回组成，必须调 query-meal-detail"},
                {"tool": "query-meals", "field": "辣度 / 口味 / 过敏原",
                 "available": False, "note": "无结构化字段，忌口只能按名称+套餐组成名做关键词匹配"},
                {"tool": "query-meal-detail", "field": "data.rounds[].choices[].isDefault",
                 "available": True, "note": "1=默认项，用它还原真实套餐组合"},
                {"tool": "query-meal-detail", "field": "supportModify",
                 "available": True, "note": "顶层可能没有，需回退到 choice.supportModify"},
                {"tool": "calculate-price", "field": "data.price / data.originalPrice / data.discount",
                 "available": True, "note": "单位是分，不要再×100"},
                {"tool": "calculate-price", "field": "couponId + couponCode",
                 "available": True, "note": "券不匹配时 success=false / code=600012，属正常业务结论"},
                {"tool": "query-store-coupons", "field": "data[].products[]",
                 "available": True, "note": "给 productCode+productName，可用于券与选品匹配"},
                {"tool": "query-store-coupons", "field": "券面额 / 折扣率",
                 "available": False, "note": "接口只给适用商品，实际优惠金额必须走 calculate-price"},
                {"tool": "query-nearby-stores", "field": "longitude / latitude",
                 "available": False, "note": "实测恒为 0.0，不能用于地图打点，只能用 address 文本"},
                {"tool": "query-my-account", "field": "会员等级",
                 "available": False, "note": "只返回积分相关字段，无等级"}
            ],
            "limits": [
                "query-meal-detail 单次约 0.4s，116 个商品串行需 40s+，必须 8 路并发并缓存 6h",
                "query-meals 返回的商品是「可售展示集」，与核价接口能接受的商品集合不一致（券内商品可能不在菜单里）",
                "券与商品不匹配时 calculate-price 返回 success=false、code=600012「促销规则不支持该商品」，属业务结论而非故障",
                "calculate-price 不缓存：改数量/换券必须实时重算，否则展示的金额不可信",
                "菜单价格是元字符串且可能为空，空值按 0 分处理，展示层需隐藏 0 元价格以免误导",
                "到店自取(beType=1)不要传 beCode，传了会报错；得来速(beType=5)才需要",
                "门店经纬度恒为 0，无法做距离排序展示，只能用接口返回的 distance",
                "now-time-info / query-my-account 无参数，用于探活，不应计入业务数据时点",
            ],
            "fallbacks": [
                {"scenario": "网络异常 / 超时 / HTTP 错误",
                 "behavior": "若同参数有历史缓存 → source=replay 并保留原始 dataTime；无缓存 → source=unavailable、ok=false、error.code=NETWORK"},
                {"scenario": "响应无法解析出 JSON",
                 "behavior": "同网络异常处理，error.code=PARSE；绝不从自然语言文本里猜价格"},
                {"scenario": "工具返回 success=false",
                 "behavior": "ok=false，error 取官方 code/message，source 仍为 live（说明接口通了，是业务上不支持）"},
                {"scenario": "券不适用（600012）",
                 "behavior": "视为「该券不能用于此单」，方案降级为无券核价，不当作系统故障"},
                {"scenario": "缺少 token",
                 "behavior": "ok=false、error.code=CONFIG，提示未找到 token；不使用任何内置常量替代"},
                {"scenario": "单条套餐详情失败",
                 "behavior": "prefetch_details 返回该 code 的 ok=false 结果，其余条目不受影响；忌口校验退化为仅看商品名"},
                {"scenario": "calculate-price 不可用",
                 "behavior": "不缓存也不估算，返回 pricing.ok=false；上层展示「未能核价」，不显示假总价"},
            ],
        }


# ---------------------------------------------------------------- 单例


_CLIENT: McdClient | None = None
_CLIENT_LOCK = threading.Lock()


def get_client() -> McdClient:
    """server.py 共用一个实例：token 只读一次，缓存写入也不会互相踩。"""
    global _CLIENT
    if _CLIENT is None:
        with _CLIENT_LOCK:
            if _CLIENT is None:
                _CLIENT = McdClient()
    return _CLIENT


def _load_token(explicit: str | None) -> tuple[str | None, str | None]:
    """token 优先级：显式入参 > 环境变量 MCD_TOKEN > ~/.workbuddy/mcp.json。

    配置文件缺失/结构异常不能崩：明确返回「未找到 token」，让上层展示可操作的提示。
    """
    for candidate in (explicit, os.environ.get("MCD_TOKEN")):
        token = _strip_bearer(candidate)
        if token:
            return token, None

    config_path = os.path.join(os.path.expanduser("~"), ".workbuddy", "mcp.json")
    try:
        with open(config_path, "r", encoding="utf-8") as handle:
            config = json.load(handle)
    except FileNotFoundError:
        return None, "未找到 token：环境变量 MCD_TOKEN 未设置，且 %s 不存在" % config_path
    except (OSError, ValueError) as exc:
        return None, "未找到 token：读取 %s 失败（%s）" % (config_path, exc)

    try:
        auth = config["mcpServers"]["mcd-mcp"]["headers"]["Authorization"]
    except (KeyError, TypeError):
        return None, "未找到 token：%s 缺少 mcpServers.mcd-mcp.headers.Authorization" % config_path

    token = _strip_bearer(auth)
    if not token:
        return None, "未找到 token：%s 中的 Authorization 为空" % config_path
    return token, None


def _strip_bearer(value) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.lower().startswith("bearer "):
        text = text[7:].strip()
    return text or None
