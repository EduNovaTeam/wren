"""SkillCatalog 的发现、安全读取与 frontmatter 校验测试。"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from wren.skills import MAX_FILE_BYTES, SkillCatalog, SkillError

REPO_ROOT = Path(__file__).resolve().parents[2]
BUILTIN_SKILLS = REPO_ROOT / "skills"

EXISTING_SKILLS = [
    "weekly-report",
    "meeting-minutes",
    "translate",
    "code-review-checklist",
    "tech-doc-writing",
    "web-research",
    "error-code-lookup",
    "metrics-query",
]


def _make_catalog(tmp_path: Path) -> SkillCatalog:
    builtin = tmp_path / "builtin"
    user = tmp_path / "user"
    builtin.mkdir()
    user.mkdir()
    return SkillCatalog(builtin, user)


def _write_skill(root: Path, name: str, frontmatter: str, body: str = "正文\n") -> Path:
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    content = f"---\n{frontmatter}\n---\n\n{body}"
    (directory / "SKILL.md").write_text(content, encoding="utf-8")
    return directory


def test_existing_skills_load() -> None:
    catalog = SkillCatalog(BUILTIN_SKILLS, BUILTIN_SKILLS / "__none__")
    listed = {item["name"]: item for item in catalog.list()}
    assert set(EXISTING_SKILLS) <= set(listed)
    for name in EXISTING_SKILLS:
        entry = catalog.load(name)
        assert entry["valid"] is True
        assert entry["body"]
        assert entry["source"] == "builtin"


def test_public_listing_has_no_body(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    _write_skill(catalog.builtin_dir, "demo", "name: demo\ndescription: 示例")
    item = catalog.list()[0]
    assert "body" not in item
    assert set(item) == {"name", "description", "source", "valid", "error", "allowed_tools"}
    assert str(catalog.builtin_dir) not in str(item)


def test_user_overrides_builtin(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    _write_skill(catalog.builtin_dir, "demo", "name: demo\ndescription: 内置")
    _write_skill(catalog.user_dir, "demo", "name: demo\ndescription: 用户")
    entries = {item["name"]: item for item in catalog.list()}
    assert entries["demo"]["source"] == "user"
    assert entries["demo"]["description"] == "用户"


def test_invalid_user_masks_builtin(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    _write_skill(catalog.builtin_dir, "demo", "name: demo\ndescription: 内置")
    _write_skill(catalog.user_dir, "demo", "name: other\ndescription: 用户")
    entries = {item["name"]: item for item in catalog.list()}
    assert entries["demo"]["valid"] is False
    assert entries["demo"]["source"] == "user"
    with pytest.raises(SkillError):
        catalog.load("demo")


def test_invalid_entry_does_not_break_others(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    _write_skill(catalog.builtin_dir, "good", "name: good\ndescription: 好")
    _write_skill(catalog.builtin_dir, "bad", "name: bad")
    entries = {item["name"]: item for item in catalog.list()}
    assert entries["good"]["valid"] is True
    assert entries["bad"]["valid"] is False


def test_folded_description_and_bom_crlf(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    directory = catalog.builtin_dir / "demo"
    directory.mkdir()
    text = "---\r\nname: demo\r\ndescription: >\r\n  多行\r\n  描述\r\n---\r\n\r\n正文\r\n"
    (directory / "SKILL.md").write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
    entry = catalog.load("demo")
    assert "多行" in entry["description"]
    assert "正文" in entry["body"]


def test_duplicate_keys_rejected(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    _write_skill(catalog.builtin_dir, "demo", "name: demo\ndescription: a\ndescription: b")
    assert catalog.list()[0]["valid"] is False


def test_alias_rejected(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    frontmatter = "name: demo\ndescription: &desc 描述\nmetadata:\n  note: *desc\n"
    _write_skill(catalog.builtin_dir, "demo", frontmatter)
    assert catalog.list()[0]["valid"] is False


def test_complex_key_rejected(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    _write_skill(catalog.builtin_dir, "demo", "name: demo\ndescription: x\n? [a, b]\n: c")
    assert catalog.list()[0]["valid"] is False


def test_wrong_type_rejected(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    _write_skill(catalog.builtin_dir, "demo", "name: demo\ndescription: 123\nallowed-tools: [a]")
    assert catalog.list()[0]["valid"] is False


def test_allowed_tools_null_rejected(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    _write_skill(catalog.builtin_dir, "demo", "name: demo\ndescription: x\nallowed-tools: null")
    assert catalog.list()[0]["valid"] is False


def test_metadata_wrong_type_rejected(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    frontmatter = "name: demo\ndescription: x\nmetadata:\n  owner: 1"
    _write_skill(catalog.builtin_dir, "demo", frontmatter)
    assert catalog.list()[0]["valid"] is False


def test_invalid_name_rejected(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    _write_skill(catalog.builtin_dir, "demo", "name: Demo\ndescription: x")
    assert catalog.list()[0]["valid"] is False


def test_missing_skill_file_invalid(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    (catalog.builtin_dir / "empty").mkdir()
    entries = {item["name"]: item for item in catalog.list()}
    assert entries["empty"]["valid"] is False
    with pytest.raises(SkillError):
        catalog.load("empty")


def test_body_lazy_loaded(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    _write_skill(catalog.builtin_dir, "demo", "name: demo\ndescription: x", body="懒加载正文\n")
    assert "body" not in catalog.list()[0]
    assert "懒加载正文" in catalog.load("demo")["body"]


def test_load_rejects_path_escape(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "SKILL.md").write_text("---\nname: x\ndescription: y\n---\n", encoding="utf-8")
    for name in ("../outside", "/etc/passwd", "C:\\Windows", ".."):
        with pytest.raises(SkillError):
            catalog.load(name)


@pytest.mark.parametrize(
    "path",
    [
        "/etc/passwd",
        "../secret.txt",
        "references/../../secret.txt",
        "C:\\Windows\\system32",
        "\\\\server\\share\\x",
        "references\\template.md",
    ],
)
def test_resource_escape_rejected(tmp_path: Path, path: str) -> None:
    catalog = _make_catalog(tmp_path)
    directory = _write_skill(catalog.builtin_dir, "demo", "name: demo\ndescription: x")
    (directory / "references").mkdir()
    (directory / "references" / "template.md").write_text("ok", encoding="utf-8")
    with pytest.raises(SkillError):
        catalog.read_resource("demo", path)


def test_resource_allowed(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    directory = _write_skill(catalog.builtin_dir, "demo", "name: demo\ndescription: x")
    (directory / "references").mkdir()
    (directory / "references" / "template.md").write_text("模板", encoding="utf-8")
    assert catalog.read_resource("demo", "references/template.md") == "模板"


def test_resource_too_large(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    directory = _write_skill(catalog.builtin_dir, "demo", "name: demo\ndescription: x")
    (directory / "big.txt").write_bytes(b"a" * (MAX_FILE_BYTES + 1))
    with pytest.raises(SkillError):
        catalog.read_resource("demo", "big.txt")


def test_resource_not_utf8(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    directory = _write_skill(catalog.builtin_dir, "demo", "name: demo\ndescription: x")
    (directory / "bin.dat").write_bytes(b"\xff\xfe\x00")
    with pytest.raises(SkillError):
        catalog.read_resource("demo", "bin.dat")


def test_skill_file_too_large(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    directory = catalog.builtin_dir / "demo"
    directory.mkdir()
    (directory / "SKILL.md").write_bytes(b"---\nname: demo\ndescription: " + b"a" * MAX_FILE_BYTES)
    assert catalog.list()[0]["valid"] is False


def _supports_symlink() -> bool:
    return hasattr(os, "symlink")


@pytest.mark.skipif(not _supports_symlink(), reason="系统不支持符号链接")
def test_symlink_skill_file_escape_rejected(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    directory = catalog.builtin_dir / "demo"
    directory.mkdir()
    outside = tmp_path / "outside.md"
    outside.write_text("---\nname: demo\ndescription: y\n---\n", encoding="utf-8")
    try:
        (directory / "SKILL.md").symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("当前系统无法创建符号链接")
    assert catalog.list()[0]["valid"] is False


@pytest.mark.skipif(not _supports_symlink(), reason="系统不支持符号链接")
def test_symlink_skill_dir_escape_rejected(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    outside = tmp_path / "outside" / "demo"
    outside.mkdir(parents=True)
    (outside / "SKILL.md").write_text("---\nname: demo\ndescription: y\n---\n", encoding="utf-8")
    try:
        (catalog.builtin_dir / "demo").symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("当前系统无法创建符号链接")
    assert catalog.list()[0]["valid"] is False


@pytest.mark.skipif(not _supports_symlink(), reason="系统不支持符号链接")
def test_symlink_resource_escape_rejected(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    directory = _write_skill(catalog.builtin_dir, "demo", "name: demo\ndescription: x")
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    link = directory / "link.txt"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("当前系统无法创建符号链接")
    with pytest.raises(SkillError):
        catalog.read_resource("demo", "link.txt")


def test_symlink_loop_is_reported_as_invalid(tmp_path: Path) -> None:
    catalog = _make_catalog(tmp_path)
    directory = catalog.builtin_dir / "loop"
    directory.mkdir()
    try:
        (directory / "SKILL.md").symlink_to("SKILL.md")
    except (OSError, NotImplementedError):
        pytest.skip("当前系统无法创建符号链接")
    assert catalog.list()[0]["valid"] is False
