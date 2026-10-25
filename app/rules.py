# -*- coding: utf-8 -*-
"""聚餐、成员与三档心愿的数据结构与校验规则。

对应规划 §5.1 / §8.2 B01：
- 「不要」是硬约束，任何低价策略都不得突破；
- 「必须要」尽量满足，无法满足必须说明原因；
- 「最好有」只参与排序，不承诺满足；
- 系统不推测未填写的偏好。

本模块只做纯函数计算，不访问网络、不读写文件，便于单测。
"""
from __future__ import annotations

import difflib
import re
import unicodedata
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

# ---------------------------------------------------------------- 常量

MAX_MEMBERS = 8
MIN_MEMBERS = 3
MAX_WISH_ITEMS = 3          # 每人每档最多 3 条，避免输入失控
NICKNAME_MAX = 12
TITLE_MAX = 30

# 「不要」的同义词组。命中任一词即视为触发该硬约束。
# 刻意保持保守：过宽的词（如单独的「椒」「牛」）会误伤「黑胡椒」「牛奶」，
# 因此只收录能明确指向该食材的词。
NEVER_GROUPS: dict[str, list[str]] = {
    "辣": ["辣", "椒麻", "辛", "藤椒", "麻辣"],
    "牛肉": ["牛肉", "牛堡", "安格斯", "厚牛", "双层牛", "吉士牛", "巨无霸"],
    "猪肉": ["猪肉", "培根", "烟肉", "猪柳", "猪"],
    "鸡肉": ["鸡"],
    "鱼": ["鱼", "鳕"],
    "海鲜": ["海鲜", "虾", "蟹", "贝"],
    "芝士": ["芝士", "奶酪", "起司"],
    "牛奶": ["奶", "乳"],
    "咖啡": ["咖啡", "拿铁", "美式", "摩卡", "卡布", "浓缩"],
    "冰": ["冰"],
    "碳酸": ["可乐", "雪碧", "汽水", "碳酸"],
    "香菜": ["香菜", "芫荽"],
    "洋葱": ["洋葱"],
    "番茄": ["番茄", "茄汁"],
    "花生": ["花生", "坚果", "榛", "杏仁", "腰果"],
    "鸡蛋": ["蛋"],
    "糖": ["糖", "甜"],
    "油炸": ["炸", "脆薯", "薯饼", "薯条"],
}

# 分类用的关键词：只用于「选主餐 / 配餐 / 饮品」的粗分类，不参与事实判断
MAIN_HINTS = ("堡", "卷", "饭", "鸡块", "桶", "拼盘", "套餐", "件套", "随心配", "沙拉")
SIDE_HINTS = ("薯条", "薯饼", "玉米", "鸡块", "鸡翅", "派", "小食", "新地", "麦旋风", "冰淇淋", "沙拉", "芝士条")
DRINK_HINTS = ("可乐", "雪碧", "茶", "咖啡", "饮", "汁", "水", "奶昔", "麦炫酷", "柠檬", "豆浆", "纯牛奶")
NOVELTY_HINTS = ("上新", "限时", "新品", "回归", "新口味")
COMBO_HINTS = ("套餐", "件套", "组合", "随心配", "分享餐", "双人", "多人")

# 「不要」输入里常见的口语前缀/后缀。用户写的是「不吃辣的」，词表里是「辣」，
# 不剥掉这些词就永远匹配不上——而这属于静默漏判，比报错更危险。
NEVER_PREFIXES = ("不吃", "不要", "不能吃", "不可以吃", "别吃", "别放", "不要放", "不加", "忌口", "忌", "没有", "无")
NEVER_SUFFIXES = ("的食物", "的东西", "之类", "过敏", "制品", "食物", "东西", "类", "味", "的")

# 用户口语与菜单命名的常见对应。刻意保持很短：只收菜单里真实存在的同义说法，
# 不做「猜你想吃」——匹配不到就如实报告未匹配。
WISH_SYNONYMS: dict[str, list[str]] = {
    "鸡块": ["麦乐鸡"],
    "麦乐鸡": ["鸡块"],
    "可乐": ["可口可乐"],
    "雪碧": ["柠檬味汽水"],
    "冰淇淋": ["新地", "麦旋风"],
    "甜筒": ["圆筒", "冰淇淋"],
    "汉堡": ["堡"],
    "薯条": ["薯条", "脆薯条"],
    "咖啡": ["麦咖啡"],
    "奶茶": ["奶昔"],
    "苹果派": ["派"],
}
WISH_THRESHOLD = 0.55      # 低于此分视为未匹配
COMBO_PENALTY = 0.85       # 心愿是具体单品时，套餐不应压过单品


# ---------------------------------------------------------------- 文本工具

def normalize(text: str) -> str:
    """全角转半角、去空白、统一小写，用于宽松包含匹配。"""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", str(text))
    text = re.sub(r"\s+", "", text)
    return text.lower()


def bigrams(text: str) -> set[str]:
    """中文没有空格分词，用字符二元组做近似相似度。"""
    text = normalize(text)
    if len(text) < 2:
        return {text} if text else set()
    return {text[i:i + 2] for i in range(len(text) - 1)}


def similarity(wish: str, target: str) -> float:
    """0~1 的粗相似度，只用于心愿匹配排序，不用于任何事实结论。"""
    w, t = normalize(wish), normalize(target)
    if not w or not t:
        return 0.0
    if w == t:
        return 1.0
    if w in t:
        # 完全包含时按长度比打折：越贴近原词越可信（「麦辣鸡腿堡」更像「麦辣鸡腿汉堡」而非八件套）
        return max(difflib.SequenceMatcher(None, w, t).ratio(),
                   0.9 * (len(w) / len(t)) ** 0.25)
    return difflib.SequenceMatcher(None, w, t).ratio()


# ---------------------------------------------------------------- 金额

def yuan_to_cents(value) -> int | None:
    """元 → 分。

    用 Decimal + ROUND_HALF_UP，与适配层（mcd_mcp）保持同一口径。
    之前这里用 float + round()，`1.005` 会得到 100 分而适配层得 101 分，
    同一个数字在两层被换算成不同金额，属于最难查的账目问题。
    """
    if value in (None, "", "-"):
        return None
    try:
        return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, TypeError, ValueError):
        return None


def cents_to_yuan(cents) -> str:
    if cents is None:
        return "—"
    return "%.2f" % (int(cents) / 100.0)


def fmt_yuan(cents) -> str:
    """展示用：¥33.50 / 未知时返回「未知」。"""
    if cents is None:
        return "未知"
    return "¥" + cents_to_yuan(cents)


# ---------------------------------------------------------------- 餐品判定

def item_haystack(item: dict) -> str:
    """忌口校验的检索文本：餐品名 + 套餐组成（若已取到详情）。"""
    parts = [item.get("name") or ""]
    parts.extend(item.get("components") or [])
    return normalize(" ".join(parts))


def _strip_never_affixes(text: str) -> str:
    """剥掉「不吃 / 的 / 之类」等口语前后缀，留下核心食材词。"""
    token = normalize(text)
    for _ in range(3):  # 允许多层，如「不要吃辣的」
        before = token
        for p in NEVER_PREFIXES:
            if token.startswith(p) and len(token) > len(p):
                token = token[len(p):]
        for s in NEVER_SUFFIXES:
            if token.endswith(s) and len(token) > len(s):
                token = token[: -len(s)]
        if token == before:
            break
    return token


def expand_never(never_texts: list[str]) -> tuple[list[str], list[str]]:
    """把「不要」文本展开为检索关键词。

    匹配顺序（命中即停）：整词等值 → 组名互含 → 组内词互含 → 原文兜底。
    互含是关键：用户写「微辣」「辣的」「不吃牛肉」，都要能落到「辣」「牛肉」这组词上。
    返回 (keywords, unknown)。unknown 是内置词表没覆盖、只能按字面匹配的词，
    前端会提示「该忌口仅按字面匹配」。
    """
    keywords: list[str] = []
    unknown: list[str] = []

    def add_all(words):
        for w in words:
            if w not in keywords:
                keywords.append(w)

    for raw in never_texts or []:
        if not (raw or "").strip():
            continue
        token = _strip_never_affixes(raw)
        if not token:
            continue

        matched_words = None
        # 1) 与组名完全一致
        for group, words in NEVER_GROUPS.items():
            if token == normalize(group):
                matched_words = words
                break
        # 2) 组名与输入双向包含（「微辣」⊃「辣」、「芝士奶酪」⊂「芝士」的反向）
        if matched_words is None:
            for group, words in NEVER_GROUPS.items():
                g = normalize(group)
                if token in g or g in token:
                    matched_words = words
                    break
        # 3) 与组内任一词双向包含（「芝士奶酪」含「芝士」、「牛肉」含「牛」）
        if matched_words is None:
            for words in NEVER_GROUPS.values():
                if any(normalize(w) in token or token in normalize(w) for w in words):
                    matched_words = words
                    break

        if matched_words:
            add_all(matched_words)
        else:
            add_all([token])
            unknown.append(raw.strip())
    return keywords, unknown


def violates(item: dict, never_keywords: list[str]) -> str | None:
    """返回命中的忌口词（None 表示不违反）。"""
    haystack = item_haystack(item)
    for kw in never_keywords:
        if kw and kw in haystack:
            return kw
    return None


def mark_flags(items: list[dict]) -> list[dict]:
    """补齐 novelty / combo 标记。MCP 层可能已给出，这里做兜底，保持幂等。"""
    for it in items:
        name = it.get("name") or ""
        tags = it.get("tags") or []
        tag_text = " ".join(tags)
        if "novelty" not in it:
            it["novelty"] = any(h in tag_text or h in name for h in NOVELTY_HINTS)
        if "combo" not in it:
            it["combo"] = any(h in name for h in COMBO_HINTS)
        it.setdefault("components", [])
    return items


def item_kind(item: dict) -> str:
    """粗分类：main / side / drink / other。仅用于搭配策略。"""
    name = item.get("name") or ""
    tags = " ".join(item.get("tags") or [])
    blob = name + " " + tags
    if any(h in blob for h in COMBO_HINTS):
        return "main"
    if any(h in name for h in DRINK_HINTS):
        return "drink"
    if any(h in name for h in SIDE_HINTS):
        return "side"
    if any(h in name for h in MAIN_HINTS):
        return "main"
    return "other"


# ---------------------------------------------------------------- 心愿匹配

def match_wish(wish: str, items: list[dict], threshold: float = WISH_THRESHOLD,
               topk: int = 5) -> list[dict]:
    """把一句自由文本心愿匹配到菜单项。

    只做「可解释」的匹配：命中的商品会展示给用户，让用户自己判断是否要调整；
    匹配不到就如实报告未匹配，绝不替用户假设。
    只保留与最高分同一档的候选（0.85×最高分），避免「麦辣鸡翅」蹭到「麦辣鸡腿堡」。
    """
    variants = [wish] + WISH_SYNONYMS.get(normalize(wish), [])
    scored = []
    for it in items:
        candidates = [it.get("name") or ""] + list(it.get("components") or [])
        score = max((similarity(v, c) for v in variants for c in candidates if c), default=0.0)
        if it.get("combo"):
            score *= COMBO_PENALTY
        if score >= threshold:
            scored.append({"productCode": it["productCode"], "name": it.get("name"),
                           "score": round(score, 3), "priceCents": it.get("priceCents"),
                           "combo": bool(it.get("combo"))})
    if not scored:
        return []
    top = max(s["score"] for s in scored)
    tier = [s for s in scored if s["score"] >= top * 0.85]
    tier.sort(key=lambda x: (-x["score"], x["priceCents"] or 0))
    seen, out = set(), []
    for s in tier:
        if s["productCode"] in seen:
            continue
        seen.add(s["productCode"])
        out.append(s)
    return out[:topk]


def resolve_wishes(members: list[dict], items: list[dict]) -> dict:
    """为每位成员解析三档心愿 → 菜单项候选。"""
    resolution: dict[str, dict] = {}
    for m in members:
        entry = {"must": [], "nice": [], "never": []}
        for wish in m.get("must") or []:
            entry["must"].append({"wish": wish, "matches": match_wish(wish, items)})
        for wish in m.get("nice") or []:
            entry["nice"].append({"wish": wish, "matches": match_wish(wish, items)})
        for wish in m.get("never") or []:
            kws, unknown = expand_never([wish])
            entry["never"].append({"wish": wish, "keywords": kws, "literalOnly": bool(unknown)})
        resolution[m["id"]] = entry
    return resolution


# ---------------------------------------------------------------- 校验

def validate_party(party: dict) -> list[dict]:
    """返回错误列表 [{field, message}]。空列表表示通过。"""
    errors: list[dict] = []

    title = (party.get("title") or "").strip()
    if not title:
        errors.append({"field": "title", "message": "请填写聚餐事由"})
    elif len(title) > TITLE_MAX:
        errors.append({"field": "title", "message": f"聚餐事由最多 {TITLE_MAX} 字"})

    try:
        count = int(party.get("memberCount") or 0)
    except (TypeError, ValueError):
        count = 0
    if not (MIN_MEMBERS <= count <= MAX_MEMBERS):
        errors.append({"field": "memberCount",
                       "message": f"人数需在 {MIN_MEMBERS}—{MAX_MEMBERS} 人之间（当前 {count}）"})

    store = party.get("store") or {}
    if not store.get("storeCode"):
        errors.append({"field": "store", "message": "请先选择门店"})
    if int(store.get("beType") or 1) == 5 and not store.get("beCode"):
        errors.append({"field": "store", "message": "得来速取餐需要门店业务编码（beCode）"})

    budget = party.get("budgetTotal")
    if budget in (None, ""):
        errors.append({"field": "budgetTotal", "message": "请填写共同预算"})
    else:
        try:
            if float(budget) <= 0:
                errors.append({"field": "budgetTotal", "message": "共同预算需大于 0"})
        except (TypeError, ValueError):
            errors.append({"field": "budgetTotal", "message": "共同预算需为数字"})

    members = party.get("members") or []
    if len(members) != count:
        errors.append({"field": "members",
                       "message": f"已填写 {len(members)} 位成员，与人数 {count} 不一致"})
    seen_ids = set()
    for idx, m in enumerate(members, 1):
        mid = m.get("id")
        who = f"第 {idx} 位成员"
        if not mid:
            errors.append({"field": "members", "message": f"{who}缺少 id"})
        elif mid in seen_ids:
            errors.append({"field": "members", "message": f"{who}的 id 重复：{mid}"})
        seen_ids.add(mid)
        nickname = (m.get("nickname") or "").strip()
        if not nickname:
            errors.append({"field": f"members.{mid}.nickname", "message": f"{who}请填写昵称"})
        elif len(nickname) > NICKNAME_MAX:
            errors.append({"field": f"members.{mid}.nickname",
                           "message": f"{who}昵称最多 {NICKNAME_MAX} 字"})
        for key, label in (("must", "必须要"), ("nice", "最好有"), ("never", "不要")):
            values = [v for v in (m.get(key) or []) if (v or "").strip()]
            if len(values) > MAX_WISH_ITEMS:
                errors.append({"field": f"members.{mid}.{key}",
                               "message": f"{who}的「{label}」最多 {MAX_WISH_ITEMS} 条"})
        budget_val = m.get("budget")
        if budget_val not in (None, ""):
            try:
                if float(budget_val) <= 0:
                    errors.append({"field": f"members.{mid}.budget",
                                   "message": f"{who}的个人预算需大于 0（不填表示不限）"})
            except (TypeError, ValueError):
                errors.append({"field": f"members.{mid}.budget",
                               "message": f"{who}的个人预算需为数字"})

    # 冲突检查：同一成员把同一词既填「必须要」又填「不要」
    for m in members:
        must_set = {normalize(x) for x in (m.get("must") or []) if x}
        never_set = {normalize(x) for x in (m.get("never") or []) if x}
        clash = must_set & never_set
        if clash:
            errors.append({"field": f"members.{m.get('id')}.wish",
                           "message": f"{m.get('nickname')} 的「{list(clash)[0]}」同时出现在必须要和不要中"})
    return errors


def normalize_member(member: dict, index: int) -> dict:
    """把前端提交的成员数据洗成稳定结构（去空、去重）。

    不再静默截断心愿条数：条数超限交给 validate_party 明确报错，
    让用户知道「没填进去」而不是悄悄丢掉。这里只做防止内存被打爆的硬上限。
    """
    def clean_list(values):
        out = []
        for v in values or []:
            text = (v or "").strip()[:60]
            if text and text not in out:
                out.append(text)
        return out[:20]

    budget = member.get("budget")
    try:
        budget = float(budget) if budget not in (None, "") else None
    except (TypeError, ValueError):
        budget = None
    return {
        "id": member.get("id") or f"m{index}",
        "nickname": (member.get("nickname") or "").strip()[:NICKNAME_MAX],
        "budget": budget,
        "must": clean_list(member.get("must")),
        "nice": clean_list(member.get("nice")),
        "never": clean_list(member.get("never")),
    }
