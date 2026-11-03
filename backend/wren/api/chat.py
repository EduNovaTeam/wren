"""会话与回合接口（浏览器调用）。"""

from __future__ import annotations

import json

from flask import Blueprint, Response, abort, current_app, stream_with_context

from .. import settings, skills, store
from ..turns import TurnRegistry, TurnRunner
from . import cfg, db, json_body

bp = Blueprint("chat", __name__, url_prefix="/api")

CONTENT_MAX = 20000


def _turns() -> TurnRegistry:
    return current_app.extensions["wren_turns"]


def _session_or_404(session_id: int) -> dict:
    session = store.get_session(db(), session_id)
    if not session:
        abort(404, "会话不存在")
    return session


@bp.get("/sessions")
def list_sessions():
    return {"sessions": store.list_sessions(db())}


@bp.post("/sessions")
def create_session():
    return store.create_session(db()), 201


@bp.patch("/sessions/<int:session_id>")
def rename_session(session_id: int):
    title = json_body().get("title")
    if not isinstance(title, str) or not title.strip():
        abort(400, "title 不能为空")
    if not store.rename_session(db(), session_id, title):
        abort(404, "会话不存在")
    return store.get_session(db(), session_id)


@bp.delete("/sessions/<int:session_id>")
def delete_session(session_id: int):
    if store.running_turn(db(), session_id):
        abort(409, "会话有进行中的回合，先停止再删除")
    if not store.delete_session(db(), session_id):
        abort(404, "会话不存在")
    return "", 204


@bp.get("/sessions/<int:session_id>/turns")
def list_turns(session_id: int):
    _session_or_404(session_id)
    return {"turns": store.list_turns(db(), session_id)}


@bp.post("/sessions/<int:session_id>/turns")
def create_turn(session_id: int):
    _session_or_404(session_id)
    content = json_body().get("content")
    if not isinstance(content, str) or not content.strip():
        abort(400, "content 不能为空")
    if len(content) > CONTENT_MAX:
        abort(400, f"消息不能超过 {CONTENT_MAX} 字")
    invoked = _check_invocation(content)
    try:
        ids = store.start_turn(db(), session_id, content)
    except store.TurnConflict as exc:
        abort(409, str(exc))
    if invoked:
        # 点名之后这个 skill 在会话里持续生效，不只是这一个回合
        store.activate_skill(db(), session_id, invoked)
    runner = TurnRunner(cfg(), session_id, ids["turn_id"], ids["user_message_id"])
    _turns().add(runner)
    runner.start()
    return ids, 201


def _check_invocation(content: str) -> str | None:
    """消息以 `/skill-name` 开头时校验；能用就返回名字，不能用直接 400，别等回合跑起来才发现。"""
    invocation = skills.parse_invocation(content)
    if not invocation:
        return None
    name = invocation[0]
    skill = skills.load_skills(skills.skill_roots(cfg())).get(name)
    if skill is None:
        abort(400, f"没有这个 skill：{name}")
    if not skill.valid:
        abort(400, f"skill「{name}」有问题，先修好再用：{'；'.join(skill.problems)}")
    if not skills.is_enabled(skill, settings.get_skill_switches(db())):
        abort(400, f"skill「{name}」已停用，先到设置里启用")
    return name


@bp.get("/turns/<int:turn_id>/events")
def turn_events(turn_id: int):
    """SSE：从回合开始补发全部事件，回合结束后关闭。已结束且不在内存里的回合直接给终态。"""
    runner = _turns().get(turn_id)
    if runner is None:
        turn = store.get_turn(db(), turn_id)
        if not turn:
            abort(404, "回合不存在")
        final = {
            "type": "turn_end",
            "turn_id": turn_id,
            "status": turn["status"] if turn["status"] != "running" else "failed",
            "error": turn["error"],
        }
        return _sse([final])

    return _sse(runner.subscribe())


@bp.post("/turns/<int:turn_id>/stop")
def stop_turn(turn_id: int):
    runner = _turns().get(turn_id)
    if runner is None:
        turn = store.get_turn(db(), turn_id)
        if not turn:
            abort(404, "回合不存在")
        return {"status": turn["status"]}
    runner.request_stop()
    return {"status": "stopping"}, 202


def _sse(events) -> Response:
    def generate():
        for event in events:
            if event is None:
                yield ": ping\n\n"
            else:
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
