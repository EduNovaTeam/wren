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


@bp.get("/sessions/<int:session_id>/skills")
def list_session_skills(session_id: int):
    """这个会话里正在生效的 skill，对话界面用它显示「生效中」并允许退出。"""
    _session_or_404(session_id)
    return {"skills": _session_skill_payload(session_id)}


@bp.delete("/sessions/<int:session_id>/skills/<name>")
def deactivate_session_skill(session_id: int, name: str):
    """退出一个 skill 的会话级生效。立刻生效，从下一个回合起不再注入。"""
    _session_or_404(session_id)
    if not skills.NAME_RE.match(name):
        abort(404, "没有这个 skill")
    store.deactivate_skill(db(), session_id, name)
    return {"skills": _session_skill_payload(session_id)}


@bp.post("/sessions/<int:session_id>/skills/<name>/primary")
def set_primary_session_skill(session_id: int, name: str):
    """指定哪个 skill 是「主导」：多个都相关时按它走，其余只在它没覆盖的地方补充。"""
    _session_or_404(session_id)
    skill = _session_skill_or_404(name)
    store.mark_primary(db(), session_id, skill.name)
    return {"skills": _session_skill_payload(session_id)}


@bp.delete("/sessions/<int:session_id>/skills/<name>/primary")
def clear_primary_session_skill(session_id: int, name: str):
    """取消指定：改回按最近使用自动决定，不用再猜用户要哪个。"""
    _session_or_404(session_id)
    skill = _session_skill_or_404(name)
    store.clear_pin(db(), session_id, skill.name)
    return {"skills": _session_skill_payload(session_id)}


def _session_skill_payload(session_id: int) -> list[dict]:
    """只列出真正在生效的：skill 被删掉、改坏或被设置页停用时，它会自己消失。"""
    found = skills.load_skills(skills.skill_roots(cfg()))
    switches = settings.get_skill_switches(db())
    pinned = store.pinned_skill(db(), session_id)
    out = []
    for name in store.session_skills(db(), session_id):
        skill = found.get(name)
        if skill is None or not skills.usable(skill, switches):
            continue
        # 排在最前的是主导，界面据此高亮；pinned 表示这是用户自己点的，不是按最近使用推出来的
        primary = not out
        out.append(
            {
                "name": skill.name,
                "description": skill.description,
                "primary": primary,
                "pinned": primary and name == pinned,
            }
        )
    return out


def _session_skill_or_404(name: str) -> skills.Skill:
    if not skills.NAME_RE.match(name):
        abort(404, "没有这个 skill")
    found = skills.load_skills(skills.skill_roots(cfg()))
    skill = found.get(name)
    if skill is None or not skills.usable(skill, settings.get_skill_switches(db())):
        abort(404, "skill 不存在、有问题或已停用")
    return skill


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
    found = skills.load_skills(skills.skill_roots(cfg()))
    skill = found.get(name)
    if skill is None:
        # 用户可能打的是文件夹名——设置页上就能看到路径。这时候只说「没有这个 skill」会让人
        # 找不到北：目录明明在，只是里面写的名字不一样。把真实名字和问题一起报出来。
        for other in found.values():
            if other.directory.name == name:
                abort(
                    400,
                    f"目录「{name}」里的 skill 声明成了「{other.name}」，两边不一致就无法使用："
                    f"{'；'.join(other.problems)}",
                )
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
