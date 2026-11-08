"""技能接口：浏览器用 /api/settings/skills 与 /api/sessions/...，agent 用 /internal/turns/...。"""

from __future__ import annotations

from flask import Blueprint, abort

from .. import settings, skill_state, store
from ..skills import SkillError
from . import cfg, db, json_body
from .internal import require_token

bp = Blueprint("skills", __name__, url_prefix="/api")
internal_bp = Blueprint("skills_internal", __name__, url_prefix="/internal/turns")
internal_bp.before_request(require_token)


def _active_metadata(loaded: list[dict]) -> list[dict]:
    """去掉正文，只保留元数据。"""
    return [{k: v for k, v in item.items() if k not in ("body",)} for item in loaded]


@bp.get("/settings/skills")
def get_skills():
    return {"skills": skill_state.list_skills(db(), cfg())}


@bp.put("/settings/skills")
def put_skills():
    body = json_body()
    try:
        skills = skill_state.update_switches(db(), cfg(), body)
    except settings.SettingsError as exc:
        abort(400, str(exc))
    return {"skills": skills}


@bp.get("/sessions/<int:session_id>/skills")
def session_skills(session_id: int):
    conn = db()
    if not store.get_session(conn, session_id):
        abort(404, "会话不存在")
    return {"skills": _active_metadata(skill_state.get_active(conn, cfg(), session_id))}


@bp.delete("/sessions/<int:session_id>/skills/<name>")
def delete_session_skill(session_id: int, name: str):
    conn = db()
    if not store.get_session(conn, session_id):
        abort(404, "会话不存在")
    running = conn.execute(
        "SELECT 1 FROM turns WHERE session_id = ? AND status = 'running' LIMIT 1",
        (session_id,),
    ).fetchone()
    if running:
        abort(409, "会话有正在运行的回合，不能移除技能")
    skill_state.deactivate(conn, session_id, name)
    return "", 204


@internal_bp.post("/<int:turn_id>/skills/<name>/activate")
def activate_skill(turn_id: int, name: str):
    turn = store.get_turn(db(), turn_id)
    if not turn:
        abort(404, "回合不存在")
    if turn["status"] != "running":
        abort(409, f"回合已结束（{turn['status']}）")
    try:
        skill = skill_state.activate(db(), cfg(), turn_id, name)
    except SkillError as exc:
        abort(400, str(exc))
    return {"skill": skill}


@internal_bp.post("/<int:turn_id>/skills/<name>/resource")
def read_skill_resource(turn_id: int, name: str):
    conn = db()
    turn = store.get_turn(conn, turn_id)
    if not turn:
        abort(404, "回合不存在")
    if turn["status"] != "running":
        abort(409, f"回合已结束（{turn['status']}）")
    active_names = {
        item["name"] for item in skill_state.get_active(conn, cfg(), turn["session_id"])
    }
    if name not in active_names:
        abort(400, f"技能 {name} 未激活或不可用")
    body = json_body()
    path = body.get("path")
    try:
        content = skill_state.catalog(cfg()).read_resource(name, path)
    except SkillError as exc:
        abort(400, str(exc))
    return {"content": content}
