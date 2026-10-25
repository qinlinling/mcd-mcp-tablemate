# -*- coding: utf-8 -*-
"""成员偏好的授权保存与复用（规划 5.7 / 4.2 P1「原班人马，再吃一次」）。

设计底线（对应规划 §11 授权先于保存）：
1. **逐人授权**：发起人不能代替别人同意保存口味；未勾选的成员一个字都不落库。
2. **最小化**：只存昵称 + 三档心愿，不存个人预算、不存订单、不存门店与金额。
   个人预算属于财务信息，复用价值也低（每次聚餐预算本来就会变）。
3. **可撤回**：每个偏好组可单独删除，删除后不可恢复。
4. **不沿用价格**：复用只回填「心愿」，菜单与价格必须重新查询、重新核价。
"""
from __future__ import annotations

import json
import os
import re
import threading
import uuid
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREF_DIR = os.path.join(BASE_DIR, ".data", "preferences")

_lock = threading.Lock()
_ID_RE = re.compile(r"^g_[0-9a-z_]+$")
MAX_MEMBERS = 8
MAX_TEXT = 20


def _ensure():
    os.makedirs(PREF_DIR, exist_ok=True)


def safe_id(group_id: str) -> str:
    if not group_id or not _ID_RE.match(group_id):
        raise ValueError("非法的偏好组 id")
    return group_id


def new_id() -> str:
    return "g_%s_%s" % (datetime.now().strftime("%Y%m%d"), uuid.uuid4().hex[:6])


def _path(group_id: str) -> str:
    return os.path.join(PREF_DIR, safe_id(group_id) + ".json")


def save_group(group: dict) -> dict:
    _ensure()
    group["updatedAt"] = datetime.now().isoformat(timespec="seconds")
    path = _path(group["groupId"])
    tmp = path + ".tmp"
    with _lock:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(group, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    return group


def get_group(group_id: str) -> dict | None:
    _ensure()
    path = _path(group_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def list_groups() -> list[dict]:
    """列表只回必要字段：成员昵称、心愿条数、创建时间。"""
    _ensure()
    out = []
    for name in sorted(os.listdir(PREF_DIR)):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(PREF_DIR, name), "r", encoding="utf-8") as f:
                g = json.load(f)
        except (OSError, ValueError):
            continue
        members = g.get("members") or []
        out.append({
            "groupId": g.get("groupId"),
            "title": g.get("title"),
            "createdAt": g.get("createdAt"),
            "memberCount": len(members),
            "nicknames": [m.get("nickname") for m in members],
            "wishCount": sum(len(m.get("must") or []) + len(m.get("nice") or []) + len(m.get("never") or [])
                             for m in members),
        })
    out.sort(key=lambda x: x.get("createdAt") or "", reverse=True)
    return out


def delete_group(group_id: str) -> bool:
    with _lock:
        try:
            os.remove(_path(group_id))
            return True
        except OSError:
            return False


def cleanup(limit: int | None = None) -> dict:
    """删除偏好组，返回 {"removed", "remaining"}。

    与 store.cleanup 同一套约束：
    - 单次受 limit 限制（宿主环境一次删太多文件会被安全策略掐断）；
    - 删除异常必须兜住 `BaseException`——拦截抛的往往不是 OSError，
      放出去会把整个请求线程带走（表现为接口无响应）。
    """
    _ensure()
    removed = 0
    remaining = 0
    with _lock:
        for name in list(os.listdir(PREF_DIR)):
            if not name.endswith(".json"):
                continue
            if limit is not None and removed >= limit:
                remaining += 1
                continue
            try:
                os.remove(os.path.join(PREF_DIR, name))
                removed += 1
            except BaseException:  # noqa: BLE001 - 环境级删除拦截可能抛非 OSError
                remaining += 1
    return {"removed": removed, "remaining": remaining}


def _clean_words(values) -> list[str]:
    out = []
    for v in values or []:
        text = (v or "").strip()[:MAX_TEXT]
        if text and text not in out:
            out.append(text)
    return out[:3]


def build_group(party: dict, consents: list[dict]) -> tuple[dict | None, list[str]]:
    """按逐人授权组装偏好组。

    consents: [{"memberId": "m1", "consent": true}]，未出现的成员视为未授权。
    返回 (group, skipped_nicknames)。一个人都没授权时 group 为 None。
    """
    consent_map = {}
    for row in consents or []:
        mid = (row or {}).get("memberId")
        if mid:
            consent_map[mid] = bool((row or {}).get("consent"))

    members = []
    skipped = []
    for m in party.get("members") or []:
        if len(members) >= MAX_MEMBERS:
            break
        if not consent_map.get(m.get("id")):
            skipped.append(m.get("nickname") or "")
            continue
        members.append({
            "nickname": (m.get("nickname") or "").strip()[:12],
            "must": _clean_words(m.get("must")),
            "nice": _clean_words(m.get("nice")),
            "never": _clean_words(m.get("never")),
            "consentAt": datetime.now().isoformat(timespec="seconds"),
        })

    if not members:
        return None, skipped

    group = {
        "groupId": new_id(),
        "sourcePartyId": party.get("id"),
        "title": (party.get("title") or "").strip()[:30],
        "createdAt": datetime.now().isoformat(timespec="seconds"),
        "members": members,
        "note": "仅保存已授权成员的三档心愿；不含个人预算、订单与金额",
    }
    return group, skipped


def party_from_group(group: dict, store_info: dict, budget_total, title: str | None = None) -> dict:
    """用偏好组生成一个新聚餐（草稿）。

    刻意不复用任何旧方案、旧价格、旧门店：菜单和价格必须重新查询（规划 5.7）。
    """
    stored = [m for m in (group.get("members") or []) if m.get("nickname")]
    members = []
    for i, m in enumerate(stored[:MAX_MEMBERS], 1):
        members.append({
            "id": f"m{i}",
            "nickname": m["nickname"],
            "budget": None,          # 个人预算不保存也不复用
            "must": list(m.get("must") or []),
            "nice": list(m.get("nice") or []),
            "never": list(m.get("never") or []),
        })
    # 聚餐下限是 3 人：偏好组可能只有 1—2 位成员授权，补齐空位让用户在第二步填写，
    # 而不是直接甩一个「人数不合法」的错误（那样用户不知道该怎么办）。
    while len(members) < 3:
        members.append({"id": f"m{len(members) + 1}", "nickname": "", "budget": None,
                        "must": [], "nice": [], "never": []})

    base_title = (title or group.get("title") or "再聚一次").strip()
    if len(base_title) > 27:
        base_title = base_title[:27]
    return {
        "id": "p_%s_%s" % (datetime.now().strftime("%Y%m%d"), uuid.uuid4().hex[:6]),
        "title": base_title + "·再聚",
        "memberCount": len(members),
        "needsFill": any(not m["nickname"] for m in members),
        "store": store_info or {},
        "budgetTotal": budget_total,
        "status": "draft",
        "members": members,
        "plans": [],
        "confirmedPlanId": None,
        "confirmedPlan": None,
        "revisitOf": group.get("groupId"),
        "createdAt": datetime.now().isoformat(timespec="seconds") + "+08:00",
        "dataTime": None,
        "dataSource": "live",
    }
