"""同桌食光票根：字段映射与脱敏（P0）。

设计原则（贯穿本模块）：
    票根只呈现最终确认方案的事实。所有字段都取自 party / plan，
    本模块不推断、不补全、不计算 party / plan 之外的事实——
    不猜门店、不猜金额、不生成订单号。用户未确认已完成的聚餐，
    一律标记为「计划中」，绝不把方案说成已消费。

对外接口：
    build_ticket(party, plan, options=None) -> dict
    default_theme_line(party, plan) -> str

仅依赖 Python 标准库。金额相关字段（totalCents / shareCents）、
门店详址、订单号即使存在于入参中，也不会出现在输出里。
"""

from __future__ import annotations

import datetime as _datetime
from typing import Any, Dict, List, Optional

# 可见字段（顺序即渲染顺序；前端据此决定「渲染还是跳过」，而不是隐藏）
# photo / notes / nextMeet 属 P1 增强：只有用户真的填了才出现，默认不进票根
VISIBLE_FIELDS = ("title", "date", "members", "items", "wishes", "themeLine",
                  "photo", "notes", "nextMeet", "status")

# P1 增强字段的输入上限：票根是社交分享物，不能变成图床或长文编辑器
PHOTO_MAX_BYTES = 600 * 1024      # dataURL 长度上限（约 450KB 原图）
NOTE_MAX_CHARS = 24
NEXT_MEET_MAX_CHARS = 40
MAX_NOTES = 8

# P0 默认隐藏字段：票根是同桌纪念，不是账单
HIDDEN_FIELDS = ["订单号", "门店详址", "个人预算", "个人分摊", "实际支付金额"]

PLACEHOLDER = "—"
SHARED_LABEL = "同桌共享"
DEFAULT_MAX_ITEMS = 3
MAX_WISHES = 4
THEME_MAX_CHARS = 20
NICKNAME_MAX_CHARS = 12

STATUS_LABELS = {"planning": "计划中", "completed": "已完成"}
PHOTO_PREFIXES = ("data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,")


# --------------------------------------------------------------------------
# 基础小工具
# --------------------------------------------------------------------------


def _text(value: Any, fallback: str = PLACEHOLDER) -> str:
    """把任意值收敛成可渲染文本；空值统一成占位符。"""
    if value is None:
        return fallback
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or fallback
    return str(value)


def _as_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _trim(text: str, limit: int) -> str:
    """按字符数截断并补省略号（中文按字计）。"""
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    if limit == 1:
        return "…"
    return text[: limit - 1] + "…"


def _members(party: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = party.get("members")
    if not isinstance(raw, list):
        return []
    return [m for m in raw if isinstance(m, dict)]


def _member_count(party: Dict[str, Any]) -> int:
    count = _as_int(party.get("memberCount"), 0)
    if count > 0:
        return count
    return len(_members(party))


def sanitize_photo(value: Any) -> Optional[str]:
    """校验并返回可用的照片 dataURL。

    只接受 jpeg/png/webp 的 base64 dataURL，且限制大小：
    - 拒绝 http(s) 外链：票根要能离线导出，外链图会让导出变成空白；
    - 拒绝 svg：可带脚本，画到 canvas 上属于不必要的攻击面。
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or not text.startswith(PHOTO_PREFIXES):
        return None
    if len(text) > PHOTO_MAX_BYTES:
        return None
    payload = text.split(",", 1)[-1]
    if not payload or any(ch.isspace() for ch in payload[:64]):
        return None
    return text


def build_notes(party: Dict[str, Any], options: Dict[str, Any],
                nicknames: Dict[str, str]) -> List[Dict[str, str]]:
    """每人一句话。只接受聚餐里存在的成员，超长按字数截断。"""
    raw = options.get("notes")
    if not isinstance(raw, dict):
        return []
    out: List[Dict[str, str]] = []
    for member in _members(party):
        member_id = str(member.get("id") or "")
        if not member_id or len(out) >= MAX_NOTES:
            continue
        value = raw.get(member_id)
        if not isinstance(value, str):
            continue
        text = value.strip()
        if not text:
            continue
        out.append({"member": nicknames.get(member_id, PLACEHOLDER),
                    "note": _trim(text, NOTE_MAX_CHARS)})
    return out


# --------------------------------------------------------------------------
# 昵称映射：用户改写优先，其次 party 里的原始昵称
# --------------------------------------------------------------------------


def _nickname_map(party: Dict[str, Any], options: Dict[str, Any]) -> Dict[str, str]:
    overrides = options.get("nicknames")
    result: Dict[str, str] = {}
    if isinstance(overrides, dict):
        for member_id, name in overrides.items():
            if not member_id or not isinstance(name, str):
                continue
            # 用户改写的昵称也要限长：不加限制会让长昵称在票根/CANVAS 上溢出（审查报告 P3-16）
            cleaned = _trim(name.strip(), NICKNAME_MAX_CHARS)
            if cleaned:
                result[str(member_id)] = cleaned
    # 未改写的成员沿用 party 昵称，保证票根与最终确认内容一致
    for member in _members(party):
        member_id = _text(member.get("id"), "")
        if not member_id or member_id in result:
            continue
        nickname = member.get("nickname")
        if isinstance(nickname, str) and nickname.strip():
            result[member_id] = nickname.strip()
    return result


def _member_names(party: Dict[str, Any], nicknames: Dict[str, str]) -> List[str]:
    names: List[str] = []
    for member in _members(party):
        member_id = _text(member.get("id"), "")
        names.append(nicknames.get(member_id, PLACEHOLDER))
    return names


# --------------------------------------------------------------------------
# 日期：只取 party 里已有的时间，不做推断
# --------------------------------------------------------------------------


def _ticket_date(party: Dict[str, Any]) -> str:
    store = party.get("store")
    store = store if isinstance(store, dict) else {}
    raw = store.get("reservationDate") or party.get("confirmedAt") or party.get("createdAt")
    text = _text(raw, "")
    if not text:
        return PLACEHOLDER
    # 只截取 YYYY-MM-DD；不做时区换算、不补全缺失日期
    return text[:10]


# --------------------------------------------------------------------------
# 代表餐品：数量降序 → 同一成员只留 1 件 → 截断到 maxItems
# --------------------------------------------------------------------------


def _pick_items(
    party: Dict[str, Any],
    plan: Dict[str, Any],
    nicknames: Dict[str, str],
    max_items: int,
) -> List[Dict[str, Any]]:
    raw_items = plan.get("items")
    if not isinstance(raw_items, list):
        return []

    candidates = []
    for index, item in enumerate(raw_items):
        if not isinstance(item, dict):
            continue
        name = _text(item.get("name"), "")
        if not name:
            continue
        quantity = _as_int(item.get("quantity"), 1)
        if quantity <= 0:
            quantity = 1
        assignee_id = _text(item.get("assigneeId"), "")
        shared = bool(item.get("shared")) or not assignee_id
        candidates.append((index, item, name, quantity, shared, assignee_id))

    # sorted 是稳定排序：数量相同的餐品保持方案内原有顺序
    ordered = sorted(candidates, key=lambda row: -row[3])

    picked: List[Dict[str, Any]] = []
    seen = set()
    for _index, item, name, quantity, shared, assignee_id in ordered:
        if shared:
            # 共享项按商品去重，允许出现多件不同的共享餐品
            assignee = SHARED_LABEL
            key = "shared:" + _text(item.get("productCode"), name)
        else:
            assignee = nicknames.get(assignee_id, PLACEHOLDER)
            key = "member:" + assignee_id
        if key in seen:
            continue
        seen.add(key)
        picked.append({"name": name, "quantity": quantity, "assignee": assignee})
        if len(picked) >= max_items:
            break
    return picked


# --------------------------------------------------------------------------
# 小心愿：只取「必须」里被满足的心愿，每人最多 1 条
# --------------------------------------------------------------------------


def _pick_wishes(
    party: Dict[str, Any],
    plan: Dict[str, Any],
    nicknames: Dict[str, str],
) -> List[Dict[str, Any]]:
    results = plan.get("wishResults")
    if not isinstance(results, dict):
        return []

    picked: List[Dict[str, Any]] = []
    for member in _members(party):
        member_id = _text(member.get("id"), "")
        result = results.get(member_id)
        if not isinstance(result, dict):
            continue
        must_list = result.get("must")
        if not isinstance(must_list, list):
            continue
        for entry in must_list:
            if not isinstance(entry, dict):
                continue
            if entry.get("status") != "satisfied":
                continue
            wish = _text(entry.get("wish"), "")
            if not wish:
                continue
            picked.append(
                {
                    "member": nicknames.get(member_id, PLACEHOLDER),
                    "wish": wish,
                    "byProduct": _text(entry.get("byProduct"), PLACEHOLDER),
                }
            )
            break  # 每人最多 1 条
        if len(picked) >= MAX_WISHES:
            break
    return picked


# --------------------------------------------------------------------------
# 主题短句：事由 + 人数，不超过 20 字，不写无法验证的夸张表述
# --------------------------------------------------------------------------


def default_theme_line(party: Dict[str, Any], plan: Optional[Dict[str, Any]] = None) -> str:
    """生成默认主题短句。只组合事由与人数这两个可核实事实。"""
    party = party if isinstance(party, dict) else {}
    title = _text(party.get("title"), "")
    count = _member_count(party)

    if count and title:
        suffix = "，{}人同桌的一餐".format(count)
        return _trim(title, THEME_MAX_CHARS - len(suffix)) + suffix
    if count:
        return "{}人同桌的一餐".format(count)
    if title:
        return _trim(title, THEME_MAX_CHARS)
    return "这一餐，同桌一起吃"


# --------------------------------------------------------------------------
# 可见字段
# --------------------------------------------------------------------------


def _visible_fields(raw: Any) -> Dict[str, bool]:
    visible = {key: True for key in VISIBLE_FIELDS}
    if isinstance(raw, dict):
        for key in VISIBLE_FIELDS:
            if key in raw:
                visible[key] = bool(raw[key])
    elif isinstance(raw, (list, tuple, set)):
        allowed = {str(item) for item in raw}
        for key in VISIBLE_FIELDS:
            visible[key] = key in allowed
    return visible


# --------------------------------------------------------------------------
# 主入口
# --------------------------------------------------------------------------


def build_ticket(
    party: Dict[str, Any],
    plan: Dict[str, Any],
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """把已确认的 party + plan 映射成票根数据。

    输出结构见 work/agent-coordination/interfaces.md §4.1。
    注意：这里逐字段新建 dict，绝不回传 pricing / allocation / store，
    因此 totalCents、shareCents、门店详址、订单号不会泄漏。
    """
    party = party if isinstance(party, dict) else {}
    plan = plan if isinstance(plan, dict) else {}
    options = options if isinstance(options, dict) else {}

    nicknames = _nickname_map(party, options)

    # 只有用户主动标记完成才算「已完成」；其余（draft/planned/confirmed）都是「计划中」
    status = "completed" if _text(party.get("status"), "") == "completed" else "planning"
    status_label = STATUS_LABELS[status]

    party_id = _text(party.get("id"), "")
    plan_id = _text(plan.get("planId"), "") or _text(party.get("confirmedPlanId"), "")
    ticket_id = "_".join([part for part in ("t", party_id, plan_id) if part]) or "t"

    max_items = _as_int(options.get("maxItems"), DEFAULT_MAX_ITEMS)
    if max_items <= 0:
        max_items = DEFAULT_MAX_ITEMS

    theme = options.get("themeLine")
    theme_line = (_trim(theme.strip(), THEME_MAX_CHARS)
                  if isinstance(theme, str) and theme.strip() else default_theme_line(party, plan))

    photo = sanitize_photo(options.get("photo"))
    notes = build_notes(party, options, nicknames)
    next_meet_raw = options.get("nextMeet")
    next_meet = (_trim(next_meet_raw.strip(), NEXT_MEET_MAX_CHARS)
                 if isinstance(next_meet_raw, str) and next_meet_raw.strip() else None)

    return {
        "ticketId": ticket_id,
        "partyId": party_id,
        "status": status,
        "statusLabel": status_label,
        "title": _text(party.get("title"), PLACEHOLDER),
        "date": _ticket_date(party),
        "members": _member_names(party, nicknames),
        "items": _pick_items(party, plan, nicknames, max_items),
        "wishes": _pick_wishes(party, plan, nicknames),
        "themeLine": theme_line,
        "photo": photo,
        "notes": notes,
        "nextMeet": next_meet,
        "fieldsVisible": _visible_fields(options.get("visibleFields")),
        "hiddenFields": list(HIDDEN_FIELDS),
        "dataTime": _text(party.get("dataTime"), ""),
        "dataSource": _text(party.get("dataSource"), "unavailable"),
        "generatedAt": _datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


__all__ = ["build_ticket", "default_theme_line", "VISIBLE_FIELDS", "HIDDEN_FIELDS"]
