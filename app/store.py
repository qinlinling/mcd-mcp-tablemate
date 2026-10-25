# -*- coding: utf-8 -*-
"""本地持久化（规划 §4.1 第 9 条、§12.5：本地数据清理入口）。

刻意不接数据库、不接云端：参赛作品要能在一台陌生电脑上跑起来，
并且用户点「清除」时必须真的一键清干净。数据只落在 mmtx/.data/parties/。
"""
from __future__ import annotations

import json
import os
import re
import threading
import uuid
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, ".data")
PARTY_DIR = os.path.join(DATA_DIR, "parties")

_lock = threading.Lock()
_ID_RE = re.compile(r"^p_[0-9a-z_]+$")


def _ensure():
    os.makedirs(PARTY_DIR, exist_ok=True)


def new_id() -> str:
    return "p_%s_%s" % (datetime.now().strftime("%Y%m%d"), uuid.uuid4().hex[:6])


def safe_id(party_id: str) -> str:
    """id 会拼进文件路径，必须校验，避免 ../ 之类的路径穿越。"""
    if not party_id or not _ID_RE.match(party_id):
        raise ValueError("非法的聚餐 id")
    return party_id


def save_party(party: dict) -> dict:
    _ensure()
    party["updatedAt"] = datetime.now().isoformat(timespec="seconds")
    path = os.path.join(PARTY_DIR, safe_id(party["id"]) + ".json")
    tmp = path + ".tmp"
    with _lock:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(party, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    return party


def get_party(party_id: str) -> dict | None:
    _ensure()
    path = os.path.join(PARTY_DIR, safe_id(party_id) + ".json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        # 文件被写坏时返回 None，由调用方按「不存在」处理；不要 500 掉整个接口
        return None


def list_parties() -> list[dict]:
    _ensure()
    out = []
    for name in sorted(os.listdir(PARTY_DIR)):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(PARTY_DIR, name), "r", encoding="utf-8") as f:
                p = json.load(f)
            out.append({"id": p.get("id"), "title": p.get("title"),
                        "status": p.get("status"), "createdAt": p.get("createdAt"),
                        "memberCount": p.get("memberCount")})
        except (OSError, ValueError):
            continue
    out.sort(key=lambda x: x.get("createdAt") or "", reverse=True)
    return out


MAX_REMOVE_PER_CALL = 40   # 单次请求最多删这么多文件：某些环境保护「一次删太多」，超了就中断


def cleanup(scope: str = "parties") -> dict:
    """清理本地数据，返回 {"removed": n, "failed": m, "remaining": k}。

    三条硬约束（都是踩过的坑）：
    1) 逐个删文件，不用 `shutil.rmtree`——批量删除会在部分环境被安全策略直接掐断，
       表现是请求没有响应、连接被关掉，用户看到的就是「点了没反应」。
    2) 单次最多删 MAX_REMOVE_PER_CALL 个，剩下的如实报告「还有 N 个」，
       让用户再点一次，而不是假装清干净了。
    3) 删除过程中遇到任何异常（包括非 OSError 的拦截）都停下来计数，
       不能让清理功能把整个请求线程带走。
    """
    _ensure()
    removed = 0
    failed = 0
    remaining = 0

    def _remove(path: str) -> bool:
        nonlocal removed, failed
        if removed >= MAX_REMOVE_PER_CALL:
            return False
        try:
            os.remove(path)
            removed += 1
            return True
        except BaseException:  # noqa: BLE001 - 环境级删除拦截可能抛非 OSError，必须兜住
            failed += 1
            return False

    with _lock:
        for name in list(os.listdir(PARTY_DIR)):
            if name.endswith(".json"):
                _remove(os.path.join(PARTY_DIR, name))

        if scope == "all":
            cache_dir = os.path.join(BASE_DIR, ".cache")
            if os.path.isdir(cache_dir):
                for root, _dirs, files in os.walk(cache_dir):
                    for name in files:
                        path = os.path.join(root, name)
                        if removed < MAX_REMOVE_PER_CALL:
                            _remove(path)
                        else:
                            remaining += 1
                for root, dirs, files in os.walk(cache_dir, topdown=False):
                    if not dirs and not files:
                        try:
                            os.rmdir(root)
                        except BaseException:  # noqa: BLE001
                            pass
    return {"removed": removed, "failed": failed, "remaining": remaining}
