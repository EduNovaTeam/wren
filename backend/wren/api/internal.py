"""内部接口（只给 agent 调用）。

所有请求必须带 `X-Wren-Internal-Token`。这里返回的内容包含 API key 等敏感信息，
不得在浏览器接口里复用这些函数。
"""

from __future__ import annotations

import hmac

from flask import Blueprint, abort, request

from .. import settings, skill_state, store
from . import cfg, db

bp = Blueprint("internal", __name__, url_prefix="/internal")


@bp.before_request
def require_token() -> None:
    token = request.headers.get("X-Wren-Internal-Token", "")
    if not hmac.compare_digest(token, cfg().internal_token):
        abort(401, "内部接口口令错误")


@bp.get("/turns/<int:turn_id>/context")
def turn_context(turn_id: int):
    """agent 开始一个回合时调用：拿到跑这个回合需要的全部输入。"""
    conn = db()
    turn = store.get_turn(conn, turn_id)
    if not turn:
        abort(404, "回合不存在")
    if turn["status"] != "running":
        abort(409, f"回合已结束（{turn['status']}）")
    current = [t for t in store.list_turns(conn, turn["session_id"]) if t["id"] == turn_id][0]
    user_message = next(m for m in current["messages"] if m["role"] == "user")
    available = [s for s in skill_state.list_skills(conn, cfg()) if s["valid"] and s["enabled"]]
    active = skill_state.get_active(conn, cfg(), turn["session_id"])
    return {
        "session_id": turn["session_id"],
        "turn_id": turn_id,
        "model": settings.get_model(conn),
        "system_prompt": settings.get_system_prompt(conn),
        "tool_switches": settings.get_tool_switches(conn),
        "history": store.history(conn, turn["session_id"], turn_id),
        "user_message": {"role": "user", "content": user_message["content"]},
        "skills": {"available": available, "active": active},
    }
