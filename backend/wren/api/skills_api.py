"""Skill 接口。

浏览器用 `/api/skills`（列表与全局开关）和 `/api/sessions/:id/skills`（会话激活项）。
agent 用 `/internal/sessions/:id/skills/*` 读写当前会话的激活状态。

Skill 的扫描、解析和校验在 agent 里完成（它掌握工具注册表）；后端只保存状态，
并把 agent 的校验结果和数据库里的开关合并后返回给界面。
"""

from __future__ import annotations

import sqlite3
from typing import Any

import requests
from flask import Blueprint, abort

from .. import settings, skills, store
from . import cfg, db, json_body
from .internal import require_token

bp = Blueprint("skills", __name__, url_prefix="/api")
internal_bp = Blueprint("skills_internal", __name__, url_prefix="/internal")
internal_bp.before_request(require_token)


# ---- 浏览器接口 -------------------------------------------------------------


@bp.get("/skills")
def list_skills():
    """全部 Skill：来源、校验结果、依赖缺失和启停状态。"""
    catalog, error = _fetch_catalog()
    if catalog is None:
        abort(502, error)
    switches = skills.get_switches(db())
    items = [{**skill, "enabled": switches.get(skill["name"], True)} for skill in catalog["skills"]]
    return {"skills": items, "errors": catalog.get("errors") or []}


@bp.put("/skills")
def put_skills():
    """批量修改全局启停，请求体是 {Skill 名: true/false}。"""
    try:
        switches = skills.update_switches(db(), json_body())
    except skills.SkillError as exc:
        abort(400, str(exc))
    return {"skills": switches}


@bp.get("/sessions/<int:session_id>/skills")
def session_skills(session_id: int):
    """会话当前激活的 Skill，并给出它们现在是否还能用。"""
    conn = db()
    if not store.get_session(conn, session_id):
        abort(404, "会话不存在")
    return {"skills": _session_rows(conn, session_id)}


@bp.delete("/sessions/<int:session_id>/skills/<name>")
def remove_session_skill(session_id: int, name: str):
    conn = db()
    if not store.get_session(conn, session_id):
        abort(404, "会话不存在")
    if not skills.deactivate(conn, session_id, name):
        abort(404, "该 Skill 未激活")
    return "", 204


# ---- 内部接口（agent 用） ---------------------------------------------------


@internal_bp.get("/sessions/<int:session_id>/skills/state")
def skill_state(session_id: int):
    conn = db()
    if not store.get_session(conn, session_id):
        abort(404, "会话不存在")
    return {
        "skill_switches": skills.get_switches(conn),
        "tool_switches": settings.get_tool_switches(conn),
        "active_skills": skills.session_skills(conn, session_id),
    }


@internal_bp.put("/sessions/<int:session_id>/skills/<name>")
def activate_session_skill(session_id: int, name: str):
    conn = db()
    if not store.get_session(conn, session_id):
        abort(404, "会话不存在")
    try:
        row = skills.activate(conn, session_id, name, json_body().get("source"))
    except skills.SkillError as exc:
        abort(400, str(exc))
    return row, 201


# ---- 辅助 -------------------------------------------------------------------


def _session_rows(conn: sqlite3.Connection, session_id: int) -> list[dict[str, Any]]:
    catalog, catalog_error = _fetch_catalog()
    by_name = {item["name"]: item for item in catalog["skills"]} if catalog is not None else {}
    switches = skills.get_switches(conn)
    rows = []
    for row in skills.session_skills(conn, session_id):
        item: dict[str, Any] = {
            "name": row["name"],
            "activated_at": row["activated_at"],
            "enabled": switches.get(row["name"], True),
        }
        if catalog is None:
            # agent 没启动时保留激活记录，界面仍然能展示，只是无法确认是否可用。
            item.update(
                status="unknown",
                description="",
                source=row["source"],
                error=catalog_error,
            )
            rows.append(item)
            continue
        skill = by_name.get(row["name"])
        item["source"] = skill["source"] if skill else row["source"]
        item["description"] = skill["description"] if skill else ""
        if skill is None:
            item.update(status="missing", error="Skill 不存在（可能已被删除）")
        elif not item["enabled"]:
            item.update(status="disabled", error="已全局停用，不再加载正文和工具")
        elif not skill["valid"]:
            item.update(status="invalid", error=skill["error"])
        else:
            item.update(status="ok", error=None)
        rows.append(item)
    return rows


def _fetch_catalog() -> tuple[dict[str, Any] | None, str | None]:
    """从 agent 取 Skill 清单。返回 (数据, 错误信息)，不抛异常。"""
    try:
        resp = requests.get(
            f"{cfg().agent_url}/skills",
            headers={"X-Wren-Internal-Token": cfg().internal_token},
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as exc:
        return None, f"无法从 agent 获取 Skill 列表：{exc.__class__.__name__}"
    except ValueError:
        return None, "agent 返回的 Skill 列表不是合法 JSON"
    if not isinstance(data, dict) or not isinstance(data.get("skills"), list):
        return None, "agent 返回的 Skill 列表格式不对"
    return data, None
