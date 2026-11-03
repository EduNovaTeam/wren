"""Skill 的启停设置和会话激活状态。

Skill 的正文、资源和校验结果都以 agent 扫描到的文件为准；这里只保存用户的选择：
全局启停，以及每个会话激活了哪些 Skill。激活状态必须独立保存，历史被截断后仍要生效。
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from .db import transaction, utcnow

NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SOURCES = ("builtin", "user")


class SkillError(ValueError):
    pass


# ---- 全局启停 ---------------------------------------------------------------


def get_switches(conn: sqlite3.Connection) -> dict[str, bool]:
    """没有出现在表里的 Skill 按「启用」处理。"""
    rows = conn.execute("SELECT name, enabled FROM skill_settings").fetchall()
    return {row["name"]: bool(row["enabled"]) for row in rows}


def update_switches(conn: sqlite3.Connection, patch: Any) -> dict[str, bool]:
    if not isinstance(patch, dict) or not all(
        isinstance(k, str) and isinstance(v, bool) for k, v in patch.items()
    ):
        raise SkillError("Skill 开关格式应为 {名称: true/false}")
    for name in patch:
        if not NAME_RE.match(name):
            raise SkillError(f"Skill 名不合法：{name}")
    now = utcnow()
    with transaction(conn):
        for name, enabled in patch.items():
            conn.execute(
                "INSERT INTO skill_settings (name, enabled, updated_at) VALUES (?, ?, ?)"
                " ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled,"
                " updated_at = excluded.updated_at",
                (name, 1 if enabled else 0, now),
            )
    return get_switches(conn)


# ---- 会话激活状态 -----------------------------------------------------------


def session_skills(conn: sqlite3.Connection, session_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT name, source, activated_at FROM session_skills"
        " WHERE session_id = ? ORDER BY activated_at, name",
        (session_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def activate(conn: sqlite3.Connection, session_id: int, name: str, source: Any) -> dict[str, Any]:
    """记录一次激活。重复激活是幂等的，保留第一次的激活时间。"""
    if not NAME_RE.match(name):
        raise SkillError(f"Skill 名不合法：{name}")
    if source not in SOURCES:
        raise SkillError(f"source 只能是 {' / '.join(SOURCES)}")
    now = utcnow()
    conn.execute(
        "INSERT INTO session_skills (session_id, name, source, activated_at)"
        " VALUES (?, ?, ?, ?)"
        " ON CONFLICT(session_id, name) DO UPDATE SET source = excluded.source",
        (session_id, name, source, now),
    )
    row = conn.execute(
        "SELECT name, source, activated_at FROM session_skills WHERE session_id = ? AND name = ?",
        (session_id, name),
    ).fetchone()
    return dict(row)


def deactivate(conn: sqlite3.Connection, session_id: int, name: str) -> bool:
    cur = conn.execute(
        "DELETE FROM session_skills WHERE session_id = ? AND name = ?",
        (session_id, name),
    )
    return cur.rowcount > 0
