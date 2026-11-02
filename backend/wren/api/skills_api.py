"""Skill 接口：浏览器用 `/api/skills`（列表与问题），agent 用 `/internal/skills`（正文与文件）。"""

from __future__ import annotations

from flask import Blueprint, abort

from .. import skills
from . import cfg
from .internal import require_token

bp = Blueprint("skills", __name__, url_prefix="/api/skills")
internal_bp = Blueprint("skills_internal", __name__, url_prefix="/internal/skills")
internal_bp.before_request(require_token)


@bp.get("")
def list_skills():
    """全部 skill 及其状态。有问题的也返回，附带 problems 供设置页展示。"""
    found = skills.load_skills(skills.skill_roots(cfg()))
    return {"skills": [skill.public() for skill in skills.sorted_skills(found)]}


@internal_bp.get("")
def internal_list():
    """给 agent：只返回可用的 skill 摘要，用于系统提示里的清单。"""
    found = skills.load_skills(skills.skill_roots(cfg()))
    return {"skills": [skill.summary() for skill in skills.sorted_skills(found) if skill.valid]}


@internal_bp.get("/<name>")
def internal_detail(name: str):
    """给 agent：一个 skill 的完整正文与附带文件列表。"""
    skill = _valid_or_404(name)
    return {
        **skill.summary(),
        "allowed_tools": list(skill.allowed_tools),
        "body": skill.body,
        "files": skills.list_files(skill),
    }


@internal_bp.get("/<name>/files/<path:rel_path>")
def internal_file(name: str, rel_path: str):
    """给 agent：读取 skill 目录内的附带文件（如 `references/style.md`）。"""
    skill = _valid_or_404(name)
    try:
        return skills.read_file(skill, rel_path)
    except skills.SkillError as exc:
        abort(400, str(exc))


def _valid_or_404(name: str) -> skills.Skill:
    if not skills.NAME_RE.match(name):
        abort(404, "skill 不存在")
    found = skills.load_skills(skills.skill_roots(cfg()))
    skill = found.get(name)
    # 有问题的 skill 不交给模型，避免它照着半截说明做事。
    if skill is None or not skill.valid:
        abort(404, "skill 不存在或有问题")
    return skill
