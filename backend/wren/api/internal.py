"""内部接口（只给 agent 调用）。

所有请求必须带 `X-Wren-Internal-Token`。这里返回的内容包含 API key 等敏感信息，
不得在浏览器接口里复用这些函数。
"""

from __future__ import annotations

import hmac

from flask import Blueprint, abort, request

from .. import settings, skills, store
from . import cfg, db

bp = Blueprint("internal", __name__, url_prefix="/internal")


@bp.before_request
def require_token():
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
    available = skills.load_skills(skills.skill_roots(cfg()))
    switches = settings.get_skill_switches(conn)
    # 用户在这个会话里退出过的 skill：清单里也不出现，否则模型翻到它、读一遍正文，
    # 这个回合又照着做了，退出等于没退。
    hidden = set(store.suppressed_skills(conn, turn["session_id"]))
    return {
        "session_id": turn["session_id"],
        "turn_id": turn_id,
        "model": settings.get_model(conn),
        "system_prompt": settings.get_system_prompt(conn),
        "tool_switches": settings.get_tool_switches(conn),
        # 只给名单，正文由 agent 按需通过 /internal/skills/<name> 取，用不到的不占上下文。
        "skills": [
            skill.summary()
            for skill in skills.sorted_skills(available)
            if skills.usable(skill, switches) and skill.name not in hidden
        ],
        # agent 要在回合提示里明说这些已经不生效：历史里还有它们成功调用过的记录，
        # 不说就会照着旧用法继续调它们带的工具。
        "left_skills": sorted(hidden),
        # 用户 `/skill-name` 点名的、以及本会话里已经用上的 skill，正文直接带上。
        "active_skills": _active_skills(
            user_message["content"],
            available,
            store.session_skills(conn, turn["session_id"]),
            switches,
        ),
        "history": store.history(conn, turn["session_id"], turn_id),
        "user_message": {"role": "user", "content": user_message["content"]},
    }


@bp.post("/sessions/<int:session_id>/skills")
def activate_session_skill(session_id: int):
    """agent 读到某个 skill 的正文后调用：把它在会话里标为生效，后续回合继续带上。"""
    conn = db()
    if not store.get_session(conn, session_id):
        abort(404, "会话不存在")
    name = (request.get_json(silent=True) or {}).get("name")
    if not isinstance(name, str) or not skills.NAME_RE.match(name):
        abort(400, "name 不合规")
    skill = skills.load_skills(skills.skill_roots(cfg())).get(name)
    if skill is None or not skills.usable(skill, settings.get_skill_switches(conn)):
        abort(404, "skill 不存在、有问题或已停用")
    store.activate_skill(conn, session_id, name, explicit=False)
    return {"skills": store.session_skills(conn, session_id)}


def _active_skills(
    text: str,
    available: dict[str, skills.Skill],
    session_names: list[str],
    switches: dict[str, bool],
) -> list[dict]:
    """本回合要注入哪些 skill：用户点名的排在前面，其余是会话里生效中的。"""
    out: list[dict] = []
    seen: set[str] = set()

    invocation = skills.parse_invocation(text)
    if invocation:
        skill = available.get(invocation[0])
        if skill is not None and skills.usable(skill, switches):
            out.append(_payload(skill, "invoked"))
            seen.add(skill.name)

    for name in session_names:
        if name in seen:
            continue
        skill = available.get(name)
        # skill 可能已经被删掉、改坏或被用户停用，跳过即可，不要让整个回合失败
        if skill is None or not skills.usable(skill, switches):
            continue
        out.append(_payload(skill, "session"))
        seen.add(name)
    return out


def _payload(skill: skills.Skill, reason: str) -> dict:
    return {
        "name": skill.name,
        "description": skill.description,
        "body": skill.body,
        "files": skills.list_files(skill),
        "allowed_tools": list(skill.allowed_tools),
        "reason": reason,
    }
