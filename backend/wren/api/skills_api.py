"""Skill 接口：浏览器用 `/api/skills`（列表、问题、启用停用），agent 用 `/internal/skills`。"""

from __future__ import annotations

from flask import Blueprint, abort

from .. import settings, skills
from . import cfg, db, json_body
from .internal import require_token

bp = Blueprint("skills", __name__, url_prefix="/api/skills")
internal_bp = Blueprint("skills_internal", __name__, url_prefix="/internal/skills")
internal_bp.before_request(require_token)


@bp.get("")
def list_skills():
    """全部 skill 及其状态。有问题的也返回，附带 problems 供设置页展示。"""
    found = skills.load_skills(skills.skill_roots(cfg()))
    switches = settings.get_skill_switches(db())
    return {
        "skills": [
            {**skill.public(), "enabled": skills.is_enabled(skill, switches)}
            for skill in skills.sorted_skills(found)
        ]
    }


@bp.put("/<name>")
def set_skill_enabled(name: str):
    """启用或停用一个 skill。停用是全局的，从下一个回合起生效。"""
    enabled = json_body().get("enabled")
    if not isinstance(enabled, bool):
        abort(400, "enabled 必须是 true 或 false")
    skill = skills.load_skills(skills.skill_roots(cfg())).get(name)
    if skill is None:
        abort(404, "没有这个 skill")
    # 有问题的 skill 本来就不交给模型，启用它没有意义，先修好
    if enabled and not skill.valid:
        abort(400, f"skill「{name}」有问题，先修好再启用：{'；'.join(skill.problems)}")
    settings.update_skill_switches(db(), {name: enabled})
    return {"name": name, "enabled": enabled}


@internal_bp.get("")
def internal_list():
    """给 agent：只返回可用的 skill 摘要，用于系统提示里的清单。"""
    found = skills.load_skills(skills.skill_roots(cfg()))
    switches = settings.get_skill_switches(db())
    return {
        "skills": [
            skill.summary()
            for skill in skills.sorted_skills(found)
            if skills.usable(skill, switches)
        ]
    }


@internal_bp.get("/<name>")
def internal_detail(name: str):
    """给 agent：一个 skill 的完整正文与附带文件列表。"""
    skill = _usable_or_404(name)
    return {
        **skill.summary(),
        "allowed_tools": list(skill.allowed_tools),
        "body": skill.body,
        "files": skills.list_files(skill),
    }


@internal_bp.get("/<name>/files/<path:rel_path>")
def internal_file(name: str, rel_path: str):
    """给 agent：读取 skill 目录内的附带文件（如 `references/style.md`）。"""
    skill = _usable_or_404(name)
    try:
        return skills.read_file(skill, rel_path)
    except skills.SkillError as exc:
        abort(400, str(exc))


def _usable_or_404(name: str) -> skills.Skill:
    if not skills.NAME_RE.match(name):
        abort(404, "skill 不存在")
    found = skills.load_skills(skills.skill_roots(cfg()))
    skill = found.get(name)
    # 有问题的、被用户停用的 skill 都不交给模型，避免它照着半截说明做事
    if skill is None or not skills.usable(skill, settings.get_skill_switches(db())):
        abort(404, "skill 不存在、有问题或已停用")
    return skill
