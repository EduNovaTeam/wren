"""Skill 的发现、解析与读取。

一个 skill 是某个目录下带 `SKILL.md` 的子目录：frontmatter 写元信息，正文写「怎么把一类事做好」。
来源有两个，后者同名时覆盖前者：

- `skills/`：仓库内置，随代码一起维护；
- `<data_dir>/skills/`：用户本地目录，不入库。

skill 属于外部内容，读取附带文件时必须留在它自己的目录内（见 `read_file`）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import Config

# skill 名会出现在工具参数和 URL 里，限制成小写字母、数字和短横线。
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
# 消息开头的 `/名字`，名字后必须是空白或行尾
COMMAND_RE = re.compile(r"^/([a-z0-9][a-z0-9-]{0,63})(?=\s|$)")
SKILL_FILE = "SKILL.md"
DESCRIPTION_MAX = 1024
FILE_MAX_BYTES = 1_000_000
LIST_LIMIT = 50

BUILTIN_DIR = Path(__file__).resolve().parents[2] / "skills"


class SkillError(ValueError):
    """读取 skill 或其附带文件失败。"""


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    source: str
    directory: Path
    body: str
    allowed_tools: tuple[str, ...]
    problems: tuple[str, ...]

    @property
    def valid(self) -> bool:
        """有问题（缺字段、名字不合规等）的 skill 不交给模型，只在设置侧展示。"""
        return not self.problems

    def summary(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "source": self.source}

    def public(self) -> dict[str, Any]:
        return {
            **self.summary(),
            "allowed_tools": list(self.allowed_tools),
            "valid": self.valid,
            "problems": list(self.problems),
            # 设置页要用它指出该改哪个文件
            "path": str(self.directory),
        }


def skill_roots(cfg: Config) -> list[tuple[str, Path]]:
    """按优先级从低到高返回来源，同名时后面的覆盖前面的。"""
    return [("builtin", BUILTIN_DIR), ("user", cfg.data_dir / "skills")]


def parse_invocation(text: str) -> tuple[str, str] | None:
    """解析消息开头的 `/skill-name`。

    返回 `(名字, 去掉命令后的正文)`；不像调用时返回 `None`。
    要求名字后面紧跟空白或行尾，所以 `/usr/bin/env 是什么` 不会被当成而调用 `usr`。
    """
    stripped = text.lstrip()
    match = COMMAND_RE.match(stripped)
    if not match:
        return None
    return match.group(1), stripped[match.end() :].strip()


def load_skills(roots: list[tuple[str, Path]]) -> dict[str, Skill]:
    """扫描所有来源，按 skill 名索引。目录或 `SKILL.md` 缺失的条目直接跳过。"""
    found: dict[str, Skill] = {}
    for source, root in roots:
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            if not entry.is_dir() or not (entry / SKILL_FILE).is_file():
                continue
            skill = _load_one(entry, source)
            if skill is not None:
                found[skill.name] = skill
    return found


def sorted_skills(skills: dict[str, Skill]) -> list[Skill]:
    return sorted(skills.values(), key=lambda s: s.name)


def is_enabled(skill: Skill, switches: dict[str, bool]) -> bool:
    """用户在设置页停用过的 skill 不再交给模型。没配置过的按启用处理。"""
    return switches.get(skill.name, True)


def usable(skill: Skill, switches: dict[str, bool]) -> bool:
    """能交给模型的条件：自身没问题，且用户没有停用它。

    会话里已经生效的 skill 被停用后不会从 session_skills 里删掉——停用只是让它暂时
    不参与，重新启用时之前用过的那些立刻恢复，用户不用再点名一次。
    """
    return skill.valid and is_enabled(skill, switches)


def list_files(skill: Skill) -> list[str]:
    """skill 目录内的附带文件（相对路径，用 `/` 分隔）。"""
    base = skill.directory.resolve()
    out: list[str] = []
    for path in sorted(base.rglob("*")):
        if len(out) >= LIST_LIMIT:
            break
        if not path.is_file() or path.name == SKILL_FILE:
            continue
        resolved = path.resolve()
        # 指向目录外的符号链接不算这个 skill 的内容。
        if not resolved.is_relative_to(base):
            continue
        out.append(resolved.relative_to(base).as_posix())
    return out


def read_file(skill: Skill, relative: str) -> dict[str, Any]:
    """读取 skill 目录内的一个文本文件；越出目录、不存在、非文本都抛 SkillError。"""
    if not relative or relative.startswith(("/", "\\")):
        raise SkillError("路径必须是 skill 目录内的相对路径")
    base = skill.directory.resolve()
    target = (base / relative).resolve()
    if not target.is_relative_to(base):
        raise SkillError("路径越出 skill 目录")
    if not target.is_file():
        raise SkillError(f"文件不存在：{relative}")
    if target.stat().st_size > FILE_MAX_BYTES:
        raise SkillError("文件过大，未读取")
    try:
        text = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise SkillError("文件不是 UTF-8 文本") from None
    except OSError as exc:
        raise SkillError(f"读取失败：{exc}") from exc
    return {"path": target.relative_to(base).as_posix(), "content": text}


# ---- 解析 -------------------------------------------------------------------


def _load_one(directory: Path, source: str) -> Skill | None:
    path = directory / SKILL_FILE
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return _broken(directory, source, f"读取 {SKILL_FILE} 失败：{exc}")

    match = _FRONTMATTER.match(text)
    if not match:
        return _broken(directory, source, "缺少 frontmatter（文件应以 --- 开头）")

    meta, problems = _parse_frontmatter(match.group(1))
    body = text[match.end() :].strip()

    name = str(meta.get("name") or "").strip()
    if not name:
        name = directory.name
        problems.append("frontmatter 缺少 name，已用目录名代替")
    elif not NAME_RE.match(name):
        problems.append(f"name 不合规（只允许小写字母、数字和短横线）：{name}")
    if name != directory.name:
        problems.append(f"name（{name}）与目录名（{directory.name}）不一致")

    description = str(meta.get("description") or "").strip()
    if not description:
        problems.append("缺少 description")
    elif len(description) > DESCRIPTION_MAX:
        problems.append(f"description 超过 {DESCRIPTION_MAX} 字")

    if not body:
        problems.append("正文为空")

    return Skill(
        name=name,
        description=description,
        source=source,
        directory=directory,
        body=body,
        allowed_tools=_allowed_tools(meta.get("allowed-tools")),
        problems=tuple(problems),
    )


def _broken(directory: Path, source: str, problem: str) -> Skill:
    return Skill(
        name=directory.name,
        description="",
        source=source,
        directory=directory,
        body="",
        allowed_tools=(),
        problems=(problem,),
    )


def _parse_frontmatter(block: str) -> tuple[dict[str, Any], list[str]]:
    """解析 frontmatter 的一个子集：顶层 `key: value`，以及一层缩进的嵌套表。

    不引入 YAML 依赖：skill 的 frontmatter 只用到这一层结构。更深的缩进会记一条问题而不是猜。
    """
    data: dict[str, Any] = {}
    problems: list[str] = []
    nested: dict[str, Any] | None = None
    for raw in block.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if raw[0] in " \t":
            if nested is None:
                problems.append(f"无法解析的 frontmatter 行：{raw.strip()}")
                continue
            key, _, value = raw.strip().partition(":")
            nested[key.strip()] = _scalar(value)
            continue
        key, sep, value = raw.partition(":")
        if not sep:
            problems.append(f"无法解析的 frontmatter 行：{raw.strip()}")
            continue
        key = key.strip()
        if value.strip():
            data[key] = _scalar(value)
            nested = None
        else:
            data[key] = {}
            nested = data[key]
    return data, problems


def _scalar(text: str) -> Any:
    value = text.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    if value.startswith("[") and value.endswith("]"):
        return [part.strip().strip("'\"") for part in value[1:-1].split(",") if part.strip()]
    return value


def _allowed_tools(value: Any) -> tuple[str, ...]:
    """`allowed-tools` 可能是空格分隔的字符串，也可能是列表。"""
    if value is None:
        return ()
    items = value if isinstance(value, list) else re.split(r"[,\s]+", str(value))
    names = [str(item).strip() for item in items]
    return tuple(dict.fromkeys(name for name in names if name))


_FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.S)
