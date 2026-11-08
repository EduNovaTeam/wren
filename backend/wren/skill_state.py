"""技能状态：技能清单（合并开关）、会话激活记录、内部回合激活的持久化。

唯一持久化仍是 SQLite（settings 表的 "skills" 键 + session_skills 表）。
agent 不保存跨回合状态，激活记录只由后端读写。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from . import settings
from .config import Config
from .db import transaction, utcnow
from .skills import SkillCatalog, SkillError

SKILLS_KEY = "skills"


def _user_dir(cfg: Config) -> Path:
    return cfg.user_skills_dir or (cfg.data_dir / "skills")


def catalog(cfg: Config) -> SkillCatalog:
    """按配置构造技能目录对象（内置目录 + 用户目录）。"""
    return SkillCatalog(Path(cfg.builtin_skills_dir), _user_dir(cfg))


def _enabled_map(conn: sqlite3.Connection) -> dict[str, bool]:
    return dict(settings._get(conn, SKILLS_KEY) or {})


def list_skills(conn: sqlite3.Connection, cfg: Config) -> list[dict[str, Any]]:
    """技能清单（不含正文），合并开关，默认启用。"""
    switches = _enabled_map(conn)
    items = catalog(cfg).list()
    for item in items:
        item["enabled"] = switches.get(item["name"], True)
    return items


def update_switches(
    conn: sqlite3.Connection, cfg: Config, patch: dict[str, Any]
) -> list[dict[str, Any]]:
    """批量更新技能开关。

    - 所有键必须是已存在的技能名，值必须是严格 bool；否则整体失败（原子）。
    - 允许把无效技能置 false，但不允许置 true。
    - 关闭技能时删除所有会话中该技能的激活记录；重新启用后不自动恢复。
    """
    items = catalog(cfg).list()
    by_name = {item["name"]: item for item in items}
    if not isinstance(patch, dict) or not all(
        isinstance(k, str) and isinstance(v, bool) for k, v in patch.items()
    ):
        raise settings.SettingsError("技能开关格式应为 {技能名: true/false}")
    unknown = [k for k in patch if k not in by_name]
    if unknown:
        raise settings.SettingsError(f"未知技能：{', '.join(sorted(unknown))}")
    for name, value in patch.items():
        if value and not by_name[name]["valid"]:
            raise settings.SettingsError(f"技能 {name} 无效，不能启用")

    disabled = [name for name, value in patch.items() if value is False]
    with transaction(conn):
        switches = {**_enabled_map(conn), **patch}
        settings._put(conn, SKILLS_KEY, switches)
        for name in disabled:
            conn.execute("DELETE FROM session_skills WHERE name = ?", (name,))
    return list_skills(conn, cfg)


def get_active(conn: sqlite3.Connection, cfg: Config, session_id: int) -> list[dict[str, Any]]:
    """会话当前激活的技能（含正文），只返回当前有效且启用的。

    缺失或损坏的技能静默过滤，避免一个坏技能拖垮整回合。
    """
    rows = conn.execute(
        "SELECT name FROM session_skills WHERE session_id = ? ORDER BY activated_at, name",
        (session_id,),
    ).fetchall()
    if not rows:
        return []
    switches = _enabled_map(conn)
    cat = catalog(cfg)
    loaded: list[dict[str, Any]] = []
    for row in rows:
        name = row["name"]
        if not switches.get(name, True):
            continue
        try:
            skill = cat.load(name)
        except (SkillError, OSError):
            continue
        if not skill.get("valid"):
            continue
        loaded.append(skill)
    return loaded


def activate(conn: sqlite3.Connection, cfg: Config, turn_id: int, name: str) -> dict[str, Any]:
    """在回合所属会话上激活技能。

    要求回合存在且为 running；技能存在、有效、启用。重复激活幂等。
    会话取自回合记录，不信任调用方提交的 session_id。
    """
    with transaction(conn):
        turn = conn.execute(
            "SELECT id, session_id, status FROM turns WHERE id = ?", (turn_id,)
        ).fetchone()
        if not turn:
            raise SkillError("回合不存在")
        if turn["status"] != "running":
            raise SkillError(f"回合已结束（{turn['status']}）")
        if not _enabled_map(conn).get(name, True):
            raise SkillError(f"技能 {name} 已禁用")
        skill = catalog(cfg).load(name)
        conn.execute(
            "INSERT INTO session_skills (session_id, name, activated_at) VALUES (?, ?, ?)"
            " ON CONFLICT(session_id, name) DO NOTHING",
            (turn["session_id"], name, utcnow()),
        )
    return skill


def deactivate(conn: sqlite3.Connection, session_id: int, name: str) -> None:
    """移除会话上的技能激活记录（不存在也算成功）。"""
    conn.execute(
        "DELETE FROM session_skills WHERE session_id = ? AND name = ?",
        (session_id, name),
    )
    conn.commit()
