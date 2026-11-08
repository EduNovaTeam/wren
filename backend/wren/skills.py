"""技能发现与安全读取。

只负责扫描两个可信根目录（内置技能与用户技能），解析 SKILL.md 的 frontmatter，
并在需要时按需读取技能正文和资源文件。不执行脚本、不自动读取资源。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

# 单个 SKILL.md 或资源文件的最大读取字节数。
MAX_FILE_BYTES = 256 * 1024

# 目录名（也作为技能名）规则：1..64 个字符，小写 ascii 字母数字与短横线，
# 不能首尾或连续短横线。
_NAME_RE = re.compile(r"^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$")

# 标准可选字符串字段（未列出的字段不解析，但会被读取）。
_STRING_FIELDS = ("compatibility", "license")

# 标准可选字段的取值上限。
_COMPATIBILITY_MAX = 500


class SkillError(ValueError):
    """技能相关的错误，消息为中文。"""


class _Loader(yaml.SafeLoader):
    """安全加载器：拒绝重复键、非字符串键与别名扩展。"""

    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
        seen: set[Any] = set()
        for key_node, _ in node.value:
            if key_node.tag == "tag:yaml.org,2002:merge":
                raise SkillError("frontmatter 含重复或复杂映射键")
            if key_node.tag == "tag:yaml.org,2002:alias":
                raise SkillError("frontmatter 使用了别名引用")
            key = self.construct_object(key_node, deep=True)
            if not isinstance(key, str):
                raise SkillError("frontmatter 的键必须是字符串")
            if key in seen:
                raise SkillError("frontmatter 含重复键")
            seen.add(key)
        return super().construct_mapping(node, deep=deep)

    def compose_node(self, parent: yaml.Node | None, index: yaml.Node | None) -> yaml.Node:
        if self.check_event(yaml.AliasEvent):
            raise SkillError("frontmatter 使用了别名引用")
        return super().compose_node(parent, index)


def _ensure_regular_file(path: Path, label: str) -> None:
    """确认路径是普通文件，拒绝目录、FIFO 等。"""
    if not path.is_file():
        raise SkillError(f"{label} 不是普通文件")


def _read_text_bounded(path: Path, label: str) -> str:
    """以有界方式读取 UTF-8 文本，容忍 BOM 与 CRLF。"""
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise SkillError(f"无法读取{label}：{exc.strerror or exc}") from exc
    if size > MAX_FILE_BYTES:
        raise SkillError(f"{label} 超过大小上限 {MAX_FILE_BYTES} 字节")
    try:
        with path.open("rb") as handle:
            data = handle.read(MAX_FILE_BYTES + 1)
    except OSError as exc:
        raise SkillError(f"无法读取{label}：{exc.strerror or exc}") from exc
    if len(data) > MAX_FILE_BYTES:
        raise SkillError(f"{label} 超过大小上限 {MAX_FILE_BYTES} 字节")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SkillError(f"{label} 不是有效的 UTF-8 文本") from exc


def _split_frontmatter(text: str) -> tuple[str, str]:
    """按整行 --- 定位 frontmatter，返回 (raw_yaml, body)。"""
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip("\r\n") != "---":
        raise SkillError("SKILL.md 缺少 frontmatter")
    close = None
    for index in range(1, len(lines)):
        if lines[index].rstrip("\r\n") == "---":
            close = index
            break
    if close is None:
        raise SkillError("SKILL.md 的 frontmatter 未闭合")
    raw = "".join(lines[1:close])
    body = "".join(lines[close + 1 :]).lstrip("\r\n")
    return raw, body


def _parse_frontmatter(raw: str) -> dict[str, Any]:
    """用自定义 SafeLoader 解析 YAML，拒绝重复键与复杂 tag。"""
    try:
        data = yaml.load(raw, Loader=_Loader)  # noqa: S506 - SafeLoader 子类
    except SkillError:
        raise
    except (yaml.YAMLError, RecursionError) as exc:
        raise SkillError("SKILL.md 的 YAML 解析失败") from exc
    if not isinstance(data, dict):
        raise SkillError("SKILL.md 的 frontmatter 必须是映射")
    return data


def _validate_name(data: dict[str, Any], dir_name: str) -> None:
    name = data.get("name")
    if not isinstance(name, str):
        raise SkillError("name 必须是字符串")
    if not _NAME_RE.match(name):
        raise SkillError("name 不符合命名规范")
    if name != dir_name:
        raise SkillError("name 必须与目录名一致")


def _validate_description(data: dict[str, Any]) -> str:
    description = data.get("description")
    if not isinstance(description, str) or not description.strip():
        raise SkillError("description 必须是非空字符串")
    if len(description) > 1024:
        raise SkillError("description 超过 1024 个字符")
    return description


def _validate_allowed_tools(data: dict[str, Any]) -> list[str]:
    if "allowed-tools" not in data:
        return []
    value = data["allowed-tools"]
    if not isinstance(value, str):
        raise SkillError("allowed-tools 必须是空白分隔的字符串")
    return value.split()


def _validate_optional_fields(data: dict[str, Any]) -> None:
    for field in _STRING_FIELDS:
        if field in data and not isinstance(data[field], str):
            raise SkillError(f"{field} 必须是字符串")
    compatibility = data.get("compatibility")
    if isinstance(compatibility, str) and len(compatibility) > _COMPATIBILITY_MAX:
        raise SkillError(f"compatibility 超过 {_COMPATIBILITY_MAX} 个字符")
    if "metadata" in data:
        metadata = data["metadata"]
        if not isinstance(metadata, dict) or not all(
            isinstance(key, str) and isinstance(value, str) for key, value in metadata.items()
        ):
            raise SkillError("metadata 必须是字符串到字符串的映射")


def _is_within(base: Path, candidate: Path) -> bool:
    """判断 candidate 是否在 base 目录之内（不含 base 本身）。"""
    try:
        candidate.relative_to(base)
    except ValueError:
        return False
    return candidate != base


def _resolve_within(base: Path, target: Path, label: str) -> Path:
    """解析 target（strict）并确认其落在 base 内，拒绝 symlink/junction 逃逸。"""
    try:
        resolved = target.resolve(strict=True)
        base_resolved = base.resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise SkillError(f"{label} 不存在或不可访问") from exc
    if not _is_within(base_resolved, resolved):
        raise SkillError(f"{label} 越界到技能目录之外")
    return resolved


class SkillCatalog:
    """扫描、校验并读取技能。"""

    def __init__(self, builtin_dir: Path, user_dir: Path) -> None:
        self.builtin_dir = Path(builtin_dir)
        self.user_dir = Path(user_dir)

    # -- 公有 API --------------------------------------------------------

    def list(self) -> list[dict[str, Any]]:
        """返回所有技能清单（不含正文与绝对路径），无效条目也保留。"""
        entries: dict[str, dict[str, Any]] = {}
        for item in self._iter_entries():
            entries[item["name"]] = self._public_entry(item)
        return list(entries.values())

    def load(self, name: str) -> dict[str, Any]:
        """返回技能元数据与正文；无效或不存在抛 SkillError。"""
        entry = self._find_entry(name)
        if entry is None:
            raise SkillError("技能不存在")
        if not entry["valid"]:
            raise SkillError(entry["error"] or "技能无效")
        skill_dir = entry["_skill_dir"]
        skill_path = entry["_skill_path"]
        if skill_dir is None or skill_path is None:
            raise SkillError("技能文件不可用")
        resolved = _resolve_within(skill_dir, skill_path, f"{name} 的 SKILL.md")
        _ensure_regular_file(resolved, f"{name} 的 SKILL.md")
        text = _read_text_bounded(resolved, f"{name} 的 SKILL.md")
        _raw, body = _split_frontmatter(text)
        result = self._public_entry(entry)
        result["body"] = body
        return result

    def read_resource(self, name: str, path: str) -> str:
        """读取有效技能目录内某个资源文件的 UTF-8 文本。"""
        entry = self._find_entry(name)
        if entry is None:
            raise SkillError("技能不存在")
        if not entry["valid"]:
            raise SkillError(entry["error"] or "技能无效")
        skill_dir = entry["_skill_dir"]
        if skill_dir is None:
            raise SkillError("技能目录不可用")
        if not isinstance(path, str) or not path:
            raise SkillError("资源路径不能为空")
        self._reject_unsafe_path(path)
        resolved = _resolve_within(skill_dir, skill_dir / path, f"资源 {path}")
        _ensure_regular_file(resolved, f"资源 {path}")
        return _read_text_bounded(resolved, f"资源 {path}")

    # -- 内部辅助 --------------------------------------------------------

    @staticmethod
    def _reject_unsafe_path(path: str) -> None:
        """拒绝绝对路径、..、Windows 盘符/UNC/反斜杠等越界形式。"""
        if "\x00" in path or ":" in path:
            raise SkillError("资源路径包含不支持的字符")
        if "\\" in path:
            raise SkillError("资源路径不得使用反斜杠")
        if path.startswith("/"):
            raise SkillError("资源路径不得为绝对路径")
        lowered = path.lower()
        if lowered.startswith("//"):
            raise SkillError("资源路径不得为 UNC 路径")
        if len(path) >= 2 and path[1] == ":":
            raise SkillError("资源路径不得包含盘符")
        parts = path.split("/")
        if any(part in ("", ".", "..") for part in parts):
            raise SkillError("资源路径不得包含 .. 或空段")

    @staticmethod
    def _public_entry(entry: dict[str, Any]) -> dict[str, Any]:
        """剔除内部字段，返回对外字段。"""
        return {
            "name": entry["name"],
            "description": entry["description"],
            "source": entry["source"],
            "valid": entry["valid"],
            "error": entry["error"],
            "allowed_tools": list(entry["allowed_tools"]),
        }

    @staticmethod
    def _invalid_entry(name: str, source: str, error: str) -> dict[str, Any]:
        return {
            "name": name,
            "description": "",
            "source": source,
            "valid": False,
            "error": error,
            "allowed_tools": [],
            "_skill_dir": None,
            "_skill_path": None,
        }

    def _find_entry(self, name: str) -> dict[str, Any] | None:
        """按名称查找条目：先完整校验名称，再定位用户/内置目录。"""
        if not isinstance(name, str) or not _NAME_RE.match(name):
            return None
        for root, source in ((self.user_dir, "user"), (self.builtin_dir, "builtin")):
            try:
                if not root.is_dir():
                    continue
                directory = root / name
                if not directory.is_dir():
                    continue
            except OSError:
                continue
            return self._diagnose(root, directory, source)
        return None

    def _iter_entries(self) -> list[dict[str, Any]]:
        """收集两个来源的直接子目录，用户同名覆盖内置（无效也覆盖）。"""
        collected: dict[str, dict[str, Any]] = {}
        for root, source in ((self.builtin_dir, "builtin"), (self.user_dir, "user")):
            for directory in self._iter_candidate_dirs(root):
                name = directory.name
                if not _NAME_RE.match(name):
                    collected[name] = self._invalid_entry(name, source, "目录名不符合命名规范")
                    continue
                collected[name] = self._diagnose(root, directory, source)
        return list(collected.values())

    @staticmethod
    def _iter_candidate_dirs(root: Path) -> list[Path]:
        """列出根下所有直接子目录；根不存在视为空。"""
        try:
            if not root.is_dir():
                return []
            children = sorted(root.iterdir(), key=lambda p: p.name)
        except OSError:
            return []
        result: list[Path] = []
        for child in children:
            try:
                if child.is_dir():
                    result.append(child)
            except OSError:
                continue
        return result

    def _diagnose(self, root: Path, directory: Path, source: str) -> dict[str, Any]:
        """对单个候选目录做全量诊断，不抛出到调用方。"""
        name = directory.name
        try:
            skill_dir = _resolve_within(root, directory, f"技能目录 {name}")
            skill_path = skill_dir / "SKILL.md"
            resolved_skill = _resolve_within(skill_dir, skill_path, f"{name} 的 SKILL.md")
            _ensure_regular_file(resolved_skill, f"{name} 的 SKILL.md")
            text = _read_text_bounded(resolved_skill, f"{name} 的 SKILL.md")
            raw, _body = _split_frontmatter(text)
            data = _parse_frontmatter(raw)
            _validate_name(data, name)
            description = _validate_description(data)
            allowed_tools = _validate_allowed_tools(data)
            _validate_optional_fields(data)
        except SkillError as exc:
            return self._invalid_entry(name, source, str(exc))
        except OSError as exc:
            return self._invalid_entry(name, source, f"无法访问技能目录：{exc.strerror or exc}")
        return {
            "name": name,
            "description": description,
            "source": source,
            "valid": True,
            "error": None,
            "allowed_tools": allowed_tools,
            "_skill_dir": skill_dir,
            "_skill_path": resolved_skill,
        }
