from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from conftest import TOKEN, read_sse

from wren import settings, skills, store
from wren.db import connect

H = {"X-Wren-Internal-Token": TOKEN}
REPO_SKILLS = Path(__file__).resolve().parents[2] / "skills"


def write_skill(root: Path, dirname: str, frontmatter: str, body: str = "# 做法\n") -> Path:
    directory = root / dirname
    directory.mkdir(parents=True)
    (directory / "SKILL.md").write_text(f"---\n{frontmatter}\n---\n\n{body}", encoding="utf-8")
    return directory


@pytest.fixture
def builtin_root(tmp_path, monkeypatch):
    root = tmp_path / "builtin"
    root.mkdir()
    monkeypatch.setattr(skills, "BUILTIN_DIR", root)
    return root


# ---- 解析 -------------------------------------------------------------------


def test_repo_skills_all_load_without_problems():
    found = skills.load_skills([("builtin", REPO_SKILLS)])
    assert {"meeting-minutes", "web-research", "translate", "metrics-query"} <= set(found)
    for skill in found.values():
        assert skill.problems == (), skill.name
        assert skill.description
        assert skill.body


def test_frontmatter_supports_nested_metadata_and_tool_list(builtin_root):
    write_skill(
        builtin_root,
        "with-tools",
        "name: with-tools\ndescription: 带工具和元信息\nallowed-tools: fetch_url run_sql\n"
        'metadata:\n  owner: data\n  version: "0.3"',
    )
    skill = skills.load_skills([("builtin", builtin_root)])["with-tools"]
    assert skill.allowed_tools == ("fetch_url", "run_sql")
    assert skill.valid and skill.source == "builtin"


def test_allowed_tools_accepts_yaml_list(builtin_root):
    write_skill(
        builtin_root,
        "list-form",
        "name: list-form\ndescription: 列表写法\nallowed-tools: [fetch_url, run_sql]",
    )
    skill = skills.load_skills([("builtin", builtin_root)])["list-form"]
    assert skill.allowed_tools == ("fetch_url", "run_sql")


def test_missing_description_and_name_mismatch_are_reported(builtin_root):
    write_skill(builtin_root, "no-desc", "name: no-desc")
    write_skill(builtin_root, "dir-name", "name: other-name\ndescription: 名字不一致")
    found = skills.load_skills([("builtin", builtin_root)])
    assert "缺少 description" in found["no-desc"].problems
    # 按 frontmatter 的 name 索引，所以名字不一致的那条挂在 other-name 下
    assert any("不一致" in problem for problem in found["other-name"].problems)
    assert not found["no-desc"].valid


def test_missing_frontmatter_is_reported(builtin_root):
    directory = builtin_root / "bare"
    directory.mkdir()
    (directory / "SKILL.md").write_text("# 没有 frontmatter\n", encoding="utf-8")
    skill = skills.load_skills([("builtin", builtin_root)])["bare"]
    assert not skill.valid and "frontmatter" in skill.problems[0]


def test_user_skills_override_builtin(tmp_path, builtin_root):
    write_skill(builtin_root, "same", "name: same\ndescription: 内置版本")
    write_skill(tmp_path / "skills", "same", "name: same\ndescription: 用户版本")
    found = skills.load_skills(skills.skill_roots(_cfg(tmp_path)))
    assert found["same"].description == "用户版本"
    assert found["same"].source == "user"


def test_invalid_user_skill_still_overrides_builtin(tmp_path, builtin_root):
    """同名一律以用户的为准：本地版本写坏了也不回退到内置版。

    这是有意选择，不是遗漏。坏掉的用户版本会被判为无效、不下发给模型，
    所以表现是该 skill 从模型侧消失；问题原因在 /api/skills 里可见。
    """
    write_skill(builtin_root, "same", "name: same\ndescription: 内置版本")
    write_skill(tmp_path / "skills", "same", "name: same")  # 缺 description
    found = skills.load_skills(skills.skill_roots(_cfg(tmp_path)))
    assert found["same"].source == "user"
    assert found["same"].valid is False


def test_user_skill_is_matched_by_frontmatter_name_not_directory(tmp_path, builtin_root):
    write_skill(builtin_root, "same", "name: same\ndescription: 内置版本")
    write_skill(tmp_path / "skills", "same", "name: other\ndescription: 目录同名但改了 name")
    found = skills.load_skills(skills.skill_roots(_cfg(tmp_path)))
    assert found["same"].source == "builtin"
    assert found["other"].valid is False  # name 与目录名不一致


def test_skill_without_skill_md_is_ignored(builtin_root):
    (builtin_root / "empty").mkdir()
    assert skills.load_skills([("builtin", builtin_root)]) == {}


# ---- 读取附带文件 -------------------------------------------------------------


def _make_dir_link(link: Path, target: Path) -> bool:
    """建一个目录链接。Windows 上普通权限建不了符号链接，改用目录联接（效果一样）。"""
    try:
        link.symlink_to(target, target_is_directory=True)
        return True
    except (OSError, NotImplementedError):
        if os.name != "nt":
            return False
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def _remove_link(path: Path) -> None:
    """只删链接本身，不碰它指向的东西。

    POSIX 的符号链接 `unlink` 就行，Windows 的目录联接得用 `rmdir`（`unlink` 会
    因为「是个目录」被拒）。两种都要处理，否则 Linux 上的 CI 会在清理时炸掉。
    """
    if not (path.exists() or path.is_symlink()):
        return
    try:
        path.unlink()
    except (IsADirectoryError, PermissionError):
        os.rmdir(path)


def test_links_inside_a_skill_are_not_followed(builtin_root):
    """skill 是外部内容：顺着链接就能读根目录外的文件、或者原地转圈，都不允许。"""
    directory = write_skill(builtin_root, "linked", "name: linked\ndescription: 带链接")
    (directory / "notes.md").write_text("自己的文件", encoding="utf-8")
    outside_dir = builtin_root.parent / "outside"
    outside_dir.mkdir()
    (outside_dir / "secret.txt").write_text("外面的机密", encoding="utf-8")
    if not _make_dir_link(directory / "secret", outside_dir):
        pytest.skip("这个环境建不了目录链接")
    try:
        if _make_dir_link(directory / "self", directory):
            pass  # 自指链接是关键用例：遍历不能原地打转
        skill = skills.load_skills([("builtin", builtin_root)])["linked"]
        # 链接目录里的东西不算它的内容，指回自己的链接不能让遍历原地打转
        assert skills.list_files(skill) == ["notes.md"]
        with pytest.raises(skills.SkillError):
            skills.read_file(skill, "secret/secret.txt")
    finally:
        # 留着自指链接会让 pytest 清理临时目录时跟着它递归进去，慢到以分钟计
        for link in (directory / "self", directory / "secret"):
            _remove_link(link)


def test_a_skill_directory_that_is_a_link_is_reported_instead_of_loaded(builtin_root):
    """指向根目录外的 skill 目录记成「有问题」，不能当成正常 skill 读。"""
    outside = builtin_root.parent / "elsewhere"
    outside.mkdir()
    (outside / "SKILL.md").write_text(
        "---\nname: sneaky\ndescription: 目录本身是链接\n---\n\n正文\n", encoding="utf-8"
    )
    (outside / "notes.md").write_text("链接目录里的东西", encoding="utf-8")
    if not _make_dir_link(builtin_root / "sneaky", outside):
        pytest.skip("这个环境建不了目录链接")
    try:
        skill = skills.load_skills([("builtin", builtin_root)])["sneaky"]
        assert skill.valid is False
        assert "链接" in skill.problems[0]
        assert skill.body == ""
        with pytest.raises(skills.SkillError):
            skills.read_file(skill, "notes.md")
    finally:
        _remove_link(builtin_root / "sneaky")


def test_read_file_returns_content_and_blocks_escape(builtin_root):
    directory = write_skill(builtin_root, "docs", "name: docs\ndescription: 带附属文件")
    (directory / "references").mkdir()
    (directory / "references" / "style.md").write_text("# 风格\n", encoding="utf-8")
    (builtin_root / "outside.md").write_text("外面的文件", encoding="utf-8")
    skill = skills.load_skills([("builtin", builtin_root)])["docs"]

    assert skills.list_files(skill) == ["references/style.md"]
    assert skills.read_file(skill, "references/style.md")["content"] == "# 风格\n"

    for bad in ("../outside.md", "/etc/passwd", "references/../../outside.md", ""):
        with pytest.raises(skills.SkillError):
            skills.read_file(skill, bad)


# ---- 接口 -------------------------------------------------------------------


def test_public_list_shows_problems_without_token(client, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    write_skill(builtin_root, "bad", "name: bad")  # 缺 description
    body = client.get("/api/skills").get_json()
    by_name = {s["name"]: s for s in body["skills"]}
    assert by_name["good"]["valid"] is True
    assert by_name["bad"]["valid"] is False and by_name["bad"]["problems"]


def test_internal_endpoints_require_token(client, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    assert client.get("/internal/skills").status_code == 401
    assert client.get("/internal/skills/good").status_code == 401


def test_internal_list_hides_invalid_skills(client, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    write_skill(builtin_root, "bad", "name: bad")
    names = [s["name"] for s in client.get("/internal/skills", headers=H).get_json()["skills"]]
    assert names == ["good"]


def test_internal_detail_returns_body_and_files(client, builtin_root):
    directory = write_skill(
        builtin_root, "docs", "name: docs\ndescription: 带文件", body="# 步骤\n"
    )
    (directory / "assets").mkdir()
    (directory / "assets" / "t.md").write_text("模板", encoding="utf-8")

    detail = client.get("/internal/skills/docs", headers=H).get_json()
    assert detail["body"].startswith("# 步骤")
    assert detail["files"] == ["assets/t.md"]

    read = client.get("/internal/skills/docs/files/assets/t.md", headers=H).get_json()
    assert read == {"path": "assets/t.md", "content": "模板"}


def test_internal_detail_404_for_unknown_and_invalid(client, builtin_root):
    write_skill(builtin_root, "bad", "name: bad")
    assert client.get("/internal/skills/nope", headers=H).status_code == 404
    assert client.get("/internal/skills/bad", headers=H).status_code == 404
    assert client.get("/internal/skills/Not_Valid", headers=H).status_code == 404


def test_internal_file_rejects_escape(client, builtin_root):
    write_skill(builtin_root, "docs", "name: docs\ndescription: 正常")
    (builtin_root / "secret.txt").write_text("x", encoding="utf-8")
    response = client.get("/internal/skills/docs/files/../secret.txt", headers=H)
    assert response.status_code in (400, 404)


def test_turn_context_carries_skill_summaries(client, agent, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    sid = client.post("/api/sessions").get_json()["id"]
    turn_id = client.post(f"/api/sessions/{sid}/turns", json={"content": "a"}).get_json()["turn_id"]

    ctx = client.get(f"/internal/turns/{turn_id}/context", headers=H).get_json()
    assert ctx["skills"] == [{"name": "good", "description": "正常", "source": "builtin"}]
    # 正文不随上下文下发，避免用不到时也占 token
    assert "body" not in ctx["skills"][0]

    agent.released.set()
    read_sse(client.get(f"/api/turns/{turn_id}/events"))


# ---- `/skill-name` 指定使用 -------------------------------------------------


def test_parse_invocation_only_matches_a_command_prefix():
    assert skills.parse_invocation("/weekly-report 帮我写周报") == ("weekly-report", "帮我写周报")
    assert skills.parse_invocation("  /weekly-report") == ("weekly-report", "")
    # 名字后面不是空白，说明是路径而不是命令
    assert skills.parse_invocation("/usr/bin/env 是什么") is None
    assert skills.parse_invocation("你好 /weekly-report") is None
    assert skills.parse_invocation("/Weekly 大小写") is None


def test_invocation_loads_skill_body_into_context(client, agent, builtin_root):
    write_skill(
        builtin_root,
        "weekly-report",
        "name: weekly-report\ndescription: 写周报",
        body="# 写周报\n先读模板",
    )
    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    sid = client.post("/api/sessions").get_json()["id"]

    response = client.post(
        f"/api/sessions/{sid}/turns", json={"content": "/weekly-report 本周做了 A"}
    )
    assert response.status_code == 201
    turn_id = response.get_json()["turn_id"]

    ctx = client.get(f"/internal/turns/{turn_id}/context", headers=H).get_json()
    assert [s["name"] for s in ctx["active_skills"]] == ["weekly-report"]
    assert "先读模板" in ctx["active_skills"][0]["body"]
    # 用户原样输入的内容照旧保留，前端不必改写显示
    assert ctx["user_message"]["content"] == "/weekly-report 本周做了 A"

    agent.released.set()
    read_sse(client.get(f"/api/turns/{turn_id}/events"))


def test_plain_message_has_no_active_skills(client, agent, builtin_root):
    write_skill(builtin_root, "weekly-report", "name: weekly-report\ndescription: 写周报")
    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    sid = client.post("/api/sessions").get_json()["id"]
    turn_id = client.post(f"/api/sessions/{sid}/turns", json={"content": "写个周报"}).get_json()[
        "turn_id"
    ]

    ctx = client.get(f"/internal/turns/{turn_id}/context", headers=H).get_json()
    assert ctx["active_skills"] == []

    agent.released.set()
    read_sse(client.get(f"/api/turns/{turn_id}/events"))


def test_invocation_of_unknown_skill_is_rejected_before_the_turn_starts(client, builtin_root):
    write_skill(builtin_root, "weekly-report", "name: weekly-report\ndescription: 写周报")
    sid = client.post("/api/sessions").get_json()["id"]

    response = client.post(f"/api/sessions/{sid}/turns", json={"content": "/nope 做点什么"})
    assert response.status_code == 400
    assert "没有这个 skill" in response.get_json()["error"]
    # 回合没有创建，所以不存在半截记录
    assert client.get(f"/api/sessions/{sid}/turns").get_json()["turns"] == []


def test_invocation_of_broken_skill_is_rejected_with_the_reason(client, builtin_root):
    write_skill(builtin_root, "broken", "name: broken")  # 缺 description
    sid = client.post("/api/sessions").get_json()["id"]

    response = client.post(f"/api/sessions/{sid}/turns", json={"content": "/broken 试试"})
    assert response.status_code == 400
    assert "缺少 description" in response.get_json()["error"]


def test_invoking_by_the_folder_name_explains_the_name_mismatch(client, builtin_root):
    """用户照着文件夹名调用时，不能只说「没有这个 skill」——目录在，只是名字写岔了。"""
    write_skill(builtin_root, "team-conventions", "name: team-style")
    sid = client.post("/api/sessions").get_json()["id"]

    response = client.post(f"/api/sessions/{sid}/turns", json={"content": "/team-conventions 试试"})
    assert response.status_code == 400
    error = response.get_json()["error"]
    assert "team-conventions" in error and "team-style" in error
    assert "与目录名" in error


def _cfg(data_dir: Path):
    from wren.config import Config

    return Config(data_dir=data_dir, agent_url="http://127.0.0.1:1", internal_token=TOKEN)


# ---- 跨回合继续生效 ----------------------------------------------------------


def _finish(client, turn_id: int):
    return read_sse(client.get(f"/api/turns/{turn_id}/events"))


def _open_turn(client, sid: int, content: str) -> int:
    """开一个卡住的回合，方便在回合进行中查上下文。"""
    created = client.post(f"/api/sessions/{sid}/turns", json={"content": content})
    return created.get_json()["turn_id"]


def _turn_skills(client, turn_id: int) -> list[dict]:
    """回合上下文里要注入的 skill（主导在前）。"""
    context = client.get(f"/internal/turns/{turn_id}/context", headers=H).get_json()
    return context["active_skills"]


def test_invoked_skill_stays_active_in_later_turns(client, agent, builtin_root):
    write_skill(
        builtin_root, "weekly-report", "name: weekly-report\ndescription: 写周报", body="# 写周报"
    )
    sid = client.post("/api/sessions").get_json()["id"]

    agent.script = [{"type": "turn_end", "status": "done"}]
    first = client.post(f"/api/sessions/{sid}/turns", json={"content": "/weekly-report 写周报"})
    _finish(client, first.get_json()["turn_id"])

    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    turn_id = _open_turn(client, sid, "继续")

    ctx = client.get(f"/internal/turns/{turn_id}/context", headers=H).get_json()
    assert [s["name"] for s in ctx["active_skills"]] == ["weekly-report"]
    # 来源是「会话里已生效」，不是「这条消息点名」
    assert ctx["active_skills"][0]["reason"] == "session"
    assert "写周报" in ctx["active_skills"][0]["body"]

    agent.released.set()
    _finish(client, turn_id)


def test_activation_is_idempotent_and_rejects_unknown(client, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    sid = client.post("/api/sessions").get_json()["id"]

    first = client.post(f"/internal/sessions/{sid}/skills", json={"name": "good"}, headers=H)
    assert first.status_code == 200
    assert first.get_json()["skills"] == ["good"]
    again = client.post(f"/internal/sessions/{sid}/skills", json={"name": "good"}, headers=H)
    assert again.get_json()["skills"] == ["good"]

    unknown = client.post(f"/internal/sessions/{sid}/skills", json={"name": "nope"}, headers=H)
    assert unknown.status_code == 404
    missing = client.post("/internal/sessions/9999/skills", json={"name": "good"}, headers=H)
    assert missing.status_code == 404


def test_skill_that_broke_after_activation_is_skipped(client, agent, builtin_root):
    directory = write_skill(builtin_root, "good", "name: good\ndescription: 正常", body="# 正文")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "good"}, headers=H)

    (directory / "SKILL.md").write_text("---\nname: good\n---\n\n正文\n", encoding="utf-8")
    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    turn_id = _open_turn(client, sid, "继续")

    ctx = client.get(f"/internal/turns/{turn_id}/context", headers=H).get_json()
    assert ctx["active_skills"] == []

    agent.released.set()
    _finish(client, turn_id)


def test_deleting_session_drops_its_skills(client, cfg, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "good"}, headers=H)

    assert client.delete(f"/api/sessions/{sid}").status_code == 204

    conn = connect(cfg.db_path)
    try:
        assert store.session_skills(conn, sid) == []
    finally:
        conn.close()


# ---- 启用与停用 --------------------------------------------------------------


def test_public_list_reports_enabled_state_and_path(client, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    listed = {s["name"]: s for s in client.get("/api/skills").get_json()["skills"]}
    assert listed["good"]["enabled"] is True
    # 设置页要能指出该改哪个目录
    assert listed["good"]["path"].endswith("good")


def test_disable_hides_skill_from_the_model_but_keeps_it_listed(client, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")

    off = client.put("/api/skills/good", json={"enabled": False})
    assert off.status_code == 200
    assert off.get_json() == {"name": "good", "enabled": False}

    assert client.get("/internal/skills", headers=H).get_json()["skills"] == []
    assert client.get("/internal/skills/good", headers=H).status_code == 404
    # 设置页仍然看得到它，只是状态为停用
    listed = {s["name"]: s for s in client.get("/api/skills").get_json()["skills"]}
    assert listed["good"]["enabled"] is False

    client.put("/api/skills/good", json={"enabled": True})
    names = [s["name"] for s in client.get("/internal/skills", headers=H).get_json()["skills"]]
    assert names == ["good"]


def test_disabled_skill_cannot_be_invoked(client, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    client.put("/api/skills/good", json={"enabled": False})
    sid = client.post("/api/sessions").get_json()["id"]

    response = client.post(f"/api/sessions/{sid}/turns", json={"content": "/good 试试"})
    assert response.status_code == 400
    assert "已停用" in response.get_json()["error"]
    assert client.get(f"/api/sessions/{sid}/turns").get_json()["turns"] == []


def test_disabled_skill_drops_out_of_the_turn_context(client, agent, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常", body="# 正文")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "good"}, headers=H)
    client.put("/api/skills/good", json={"enabled": False})

    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    turn_id = _open_turn(client, sid, "继续")

    ctx = client.get(f"/internal/turns/{turn_id}/context", headers=H).get_json()
    assert ctx["skills"] == []
    assert ctx["active_skills"] == []

    agent.released.set()
    _finish(client, turn_id)


def test_reenabling_restores_the_session_skill(client, cfg, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常", body="# 正文")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "good"}, headers=H)

    client.put("/api/skills/good", json={"enabled": False})
    client.put("/api/skills/good", json={"enabled": True})

    # 停用只是暂时不参与，不该把会话里用过的 skill 忘掉
    conn = connect(cfg.db_path)
    try:
        assert store.session_skills(conn, sid) == ["good"]
    finally:
        conn.close()


def test_internal_activation_rejects_a_disabled_skill(client, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    sid = client.post("/api/sessions").get_json()["id"]
    client.put("/api/skills/good", json={"enabled": False})

    response = client.post(f"/internal/sessions/{sid}/skills", json={"name": "good"}, headers=H)
    assert response.status_code == 404


def test_broken_skill_cannot_be_enabled(client, builtin_root):
    write_skill(builtin_root, "bad", "name: bad")  # 缺 description
    response = client.put("/api/skills/bad", json={"enabled": True})
    assert response.status_code == 400
    assert "缺少 description" in response.get_json()["error"]


def test_toggle_validates_name_and_body(client, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    assert client.put("/api/skills/nope", json={"enabled": True}).status_code == 404
    assert client.put("/api/skills/Not_Valid", json={"enabled": True}).status_code == 404
    assert client.put("/api/skills/good", json={"enabled": "yes"}).status_code == 400
    assert client.put("/api/skills/good", json={}).status_code == 400


def test_disable_is_persisted_in_settings(client, cfg, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    client.put("/api/skills/good", json={"enabled": False})

    conn = connect(cfg.db_path)
    try:
        assert settings.get_skill_switches(conn) == {"good": False}
    finally:
        conn.close()


# ---- 退出会话级生效 ----------------------------------------------------------


def test_session_skill_list_shows_what_is_in_effect(client, builtin_root):
    write_skill(builtin_root, "weekly-report", "name: weekly-report\ndescription: 写周报")
    sid = client.post("/api/sessions").get_json()["id"]
    assert client.get(f"/api/sessions/{sid}/skills").get_json() == {"skills": []}

    client.post(f"/internal/sessions/{sid}/skills", json={"name": "weekly-report"}, headers=H)
    assert client.get(f"/api/sessions/{sid}/skills").get_json()["skills"] == [
        {"name": "weekly-report", "description": "写周报", "primary": True, "pinned": False}
    ]


def test_leaving_a_skill_drops_it_from_the_next_turn(client, agent, builtin_root):
    write_skill(
        builtin_root, "weekly-report", "name: weekly-report\ndescription: 写周报", body="# 正文"
    )
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "weekly-report"}, headers=H)

    response = client.delete(f"/api/sessions/{sid}/skills/weekly-report")
    assert response.status_code == 200
    assert response.get_json()["skills"] == []

    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    turn_id = _open_turn(client, sid, "继续")
    ctx = client.get(f"/internal/turns/{turn_id}/context", headers=H).get_json()
    assert ctx["active_skills"] == []

    agent.released.set()
    _finish(client, turn_id)


def test_model_reading_it_again_does_not_revive_a_skill_the_user_left(client, builtin_root):
    write_skill(builtin_root, "weekly-report", "name: weekly-report\ndescription: 写周报")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "weekly-report"}, headers=H)
    client.delete(f"/api/sessions/{sid}/skills/weekly-report")

    # 用户点过退出之后，模型再读一遍正文，不该把它悄悄拉回生效状态
    again = client.post(
        f"/internal/sessions/{sid}/skills", json={"name": "weekly-report"}, headers=H
    )
    assert again.status_code == 200
    assert client.get(f"/api/sessions/{sid}/skills").get_json()["skills"] == []


def test_slash_command_brings_a_left_skill_back(client, agent, builtin_root):
    write_skill(builtin_root, "weekly-report", "name: weekly-report\ndescription: 写周报")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "weekly-report"}, headers=H)
    client.delete(f"/api/sessions/{sid}/skills/weekly-report")

    agent.script = [{"type": "turn_end", "status": "done"}]
    created = client.post(f"/api/sessions/{sid}/turns", json={"content": "/weekly-report 再来"})
    _finish(client, created.get_json()["turn_id"])

    listed = client.get(f"/api/sessions/{sid}/skills").get_json()["skills"]
    assert [s["name"] for s in listed] == ["weekly-report"]


def test_left_skill_keeps_its_row_so_it_can_come_back(client, cfg, builtin_root):
    write_skill(builtin_root, "weekly-report", "name: weekly-report\ndescription: 写周报")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "weekly-report"}, headers=H)
    client.delete(f"/api/sessions/{sid}/skills/weekly-report")

    conn = connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT suppressed_at FROM session_skills WHERE session_id = ? AND skill_name = ?",
            (sid, "weekly-report"),
        ).fetchone()
    finally:
        conn.close()
    # 不是删掉而是打标记：模型随后读到它也不能复活，用户 /名字 点名才清掉
    assert row is not None and row["suppressed_at"]


def test_session_skill_list_hides_deleted_and_globally_disabled(client, builtin_root):
    directory = write_skill(builtin_root, "gone", "name: gone\ndescription: 会被删")
    write_skill(builtin_root, "off", "name: off\ndescription: 会被停用")
    sid = client.post("/api/sessions").get_json()["id"]
    for name in ("gone", "off"):
        client.post(f"/internal/sessions/{sid}/skills", json={"name": name}, headers=H)
    listed = client.get(f"/api/sessions/{sid}/skills").get_json()["skills"]
    assert {s["name"] for s in listed} == {"gone", "off"}

    shutil.rmtree(directory)
    client.put("/api/skills/off", json={"enabled": False})
    assert client.get(f"/api/sessions/{sid}/skills").get_json()["skills"] == []


def test_session_skill_endpoints_need_a_real_session(client, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    assert client.get("/api/sessions/9999/skills").status_code == 404
    assert client.delete("/api/sessions/9999/skills/good").status_code == 404

    sid = client.post("/api/sessions").get_json()["id"]
    # 退出一个没生效过的 skill 不算错：用户要的结果（它不生效）已经成立
    assert client.delete(f"/api/sessions/{sid}/skills/good").status_code == 200
    assert client.delete(f"/api/sessions/{sid}/skills/Not_Valid").status_code == 404


def test_left_skill_disappears_from_the_agent_side_too(client, builtin_root):
    """只挡住系统提示的注入不够：模型还能自己翻清单、读正文，那等于没退出。"""
    write_skill(builtin_root, "weekly-report", "name: weekly-report\ndescription: 写周报")
    write_skill(builtin_root, "other", "name: other\ndescription: 另一个")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "weekly-report"}, headers=H)
    client.delete(f"/api/sessions/{sid}/skills/weekly-report")

    # 不带会话：照旧全部可见（别的会话、以及没有会话的调用方）
    everything = [s["name"] for s in client.get("/internal/skills", headers=H).get_json()["skills"]]
    assert everything == ["other", "weekly-report"]

    # 带上会话：清单里没有它，正文和附带文件也读不到
    listed = client.get(f"/internal/skills?session={sid}", headers=H).get_json()["skills"]
    assert [s["name"] for s in listed] == ["other"]
    detail = client.get(f"/internal/skills/weekly-report?session={sid}", headers=H)
    assert detail.status_code == 404
    attachment = client.get(f"/internal/skills/weekly-report/files/x.md?session={sid}", headers=H)
    assert attachment.status_code == 404

    # 别的会话不受影响
    other_sid = client.post("/api/sessions").get_json()["id"]
    visible = client.get(f"/internal/skills/weekly-report?session={other_sid}", headers=H)
    assert visible.status_code == 200
    both = client.get(f"/internal/skills?session={other_sid}", headers=H).get_json()["skills"]
    assert [s["name"] for s in both] == ["other", "weekly-report"]


def test_turn_context_hides_the_left_skill_from_the_catalog(client, agent, builtin_root):
    write_skill(builtin_root, "weekly-report", "name: weekly-report\ndescription: 写周报")
    write_skill(builtin_root, "other", "name: other\ndescription: 另一个")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "weekly-report"}, headers=H)
    client.delete(f"/api/sessions/{sid}/skills/weekly-report")

    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    turn_id = _open_turn(client, sid, "继续")
    ctx = client.get(f"/internal/turns/{turn_id}/context", headers=H).get_json()
    assert [s["name"] for s in ctx["skills"]] == ["other"]
    assert ctx["active_skills"] == []
    # agent 要靠这个在回合提示里说明「这些不再生效」，否则模型会照历史里的旧用法继续调
    assert ctx["left_skills"] == ["weekly-report"]

    agent.released.set()
    _finish(client, turn_id)


def test_bad_session_argument_is_rejected(client, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    assert client.get("/internal/skills?session=abc", headers=H).status_code == 400


# ---- 多个 skill 同时生效：一个主导，其余待命 ----------------------------------


def test_the_most_recently_used_skill_is_the_primary_one(client, agent, builtin_root):
    write_skill(builtin_root, "older", "name: older\ndescription: 先用的", body="# 先用的正文")
    write_skill(builtin_root, "newer", "name: newer\ndescription: 后用的", body="# 后用的正文")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "older"}, headers=H)
    time.sleep(0.02)  # last_used_at 是毫秒精度，隔开一点才排得出先后
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "newer"}, headers=H)

    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    turn_id = _open_turn(client, sid, "随便问点什么")
    skills_ctx = _turn_skills(client, turn_id)

    # 最近用过的排最前，且是唯一带正文的那个
    assert [s["name"] for s in skills_ctx] == ["newer", "older"]
    assert [s["role"] for s in skills_ctx] == ["primary", "secondary"]
    assert skills_ctx[0]["body"] == "# 后用的正文"
    assert skills_ctx[1]["body"] == ""

    agent.released.set()
    _finish(client, turn_id)


def test_a_named_skill_leads_no_matter_what_was_used_before(client, agent, builtin_root):
    write_skill(builtin_root, "older", "name: older\ndescription: 先用的", body="# 先用的正文")
    write_skill(builtin_root, "newer", "name: newer\ndescription: 后用的", body="# 后用的正文")
    sid = client.post("/api/sessions").get_json()["id"]
    for name in ("older", "newer"):
        client.post(f"/internal/sessions/{sid}/skills", json={"name": name}, headers=H)

    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    turn_id = _open_turn(client, sid, "/older 按这个来")
    skills_ctx = _turn_skills(client, turn_id)

    assert [s["name"] for s in skills_ctx] == ["older", "newer"]
    assert [s["role"] for s in skills_ctx] == ["primary", "secondary"]
    assert skills_ctx[0]["reason"] == "invoked"

    agent.released.set()
    _finish(client, turn_id)


def test_secondary_skills_still_hand_over_their_tools(client, agent, builtin_root):
    """待命的只是不给正文，工具还是要开放，否则读正文就得等下一回合。"""
    write_skill(
        builtin_root,
        "with-tools",
        "name: with-tools\ndescription: 带工具\nallowed-tools: fetch_url",
        body="# 正文",
    )
    write_skill(builtin_root, "lead", "name: lead\ndescription: 主导", body="# 主导正文")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "with-tools"}, headers=H)
    time.sleep(0.02)
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "lead"}, headers=H)

    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    turn_id = _open_turn(client, sid, "开始")
    skills_ctx = _turn_skills(client, turn_id)
    assert [s["role"] for s in skills_ctx] == ["primary", "secondary"]
    assert skills_ctx[1]["allowed_tools"] == ["fetch_url"]

    agent.released.set()
    _finish(client, turn_id)


def test_user_can_pick_the_primary_skill(client, builtin_root):
    write_skill(builtin_root, "first", "name: first\ndescription: 第一个")
    write_skill(builtin_root, "second", "name: second\ndescription: 第二个")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "first"}, headers=H)
    time.sleep(0.02)
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "second"}, headers=H)

    listed = client.get(f"/api/sessions/{sid}/skills").get_json()["skills"]
    assert [(s["name"], s["primary"]) for s in listed] == [("second", True), ("first", False)]

    response = client.post(f"/api/sessions/{sid}/skills/first/primary")
    assert response.status_code == 200
    after = response.get_json()["skills"]
    assert [(s["name"], s["primary"], s["pinned"]) for s in after] == [
        ("first", True, True),
        ("second", False, False),
    ]

    # 点名一个不认识或已经坏掉的，照旧 404
    assert client.post(f"/api/sessions/{sid}/skills/nope/primary").status_code == 404


def test_a_pinned_skill_is_not_displaced_by_the_model_reading_another(client, agent, builtin_root):
    """用户点了主导，模型读了一次别的 skill——主导不能因此换人。"""
    write_skill(builtin_root, "lead", "name: lead\ndescription: 用户选的主导", body="# 主导正文")
    write_skill(builtin_root, "other", "name: other\ndescription: 另一个", body="# 另一个正文")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "lead"}, headers=H)
    time.sleep(0.02)
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "other"}, headers=H)
    client.post(f"/api/sessions/{sid}/skills/lead/primary")

    # 模型在回合里读了 other，会刷新它的最近使用时间
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "other"}, headers=H)

    listed = client.get(f"/api/sessions/{sid}/skills").get_json()["skills"]
    assert [(s["name"], s["primary"], s["pinned"]) for s in listed] == [
        ("lead", True, True),
        ("other", False, False),
    ]

    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    turn_id = _open_turn(client, sid, "随便问")
    skills_ctx = _turn_skills(client, turn_id)
    assert [s["name"] for s in skills_ctx] == ["lead", "other"]
    assert skills_ctx[0]["pinned"] is True
    assert skills_ctx[0]["body"] == "# 主导正文"

    agent.released.set()
    _finish(client, turn_id)


def test_unpinning_falls_back_to_the_most_recently_used(client, builtin_root):
    write_skill(builtin_root, "first", "name: first\ndescription: 先用的")
    write_skill(builtin_root, "second", "name: second\ndescription: 后用的")
    sid = client.post("/api/sessions").get_json()["id"]
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "first"}, headers=H)
    time.sleep(0.02)
    client.post(f"/internal/sessions/{sid}/skills", json={"name": "second"}, headers=H)
    client.post(f"/api/sessions/{sid}/skills/first/primary")

    listed = client.get(f"/api/sessions/{sid}/skills").get_json()["skills"]
    assert listed[0]["name"] == "first" and listed[0]["pinned"] is True

    # 再点一次取消指定：不再固定在 first 上。它仍然是主导，但那是因为它刚被用过，
    # 属于「自动」而不是「用户指定」，模型下次读别的 skill 就能把它带过去。
    response = client.delete(f"/api/sessions/{sid}/skills/first/primary")
    assert response.status_code == 200
    after = response.get_json()["skills"]
    assert after[0]["name"] == "first" and after[0]["pinned"] is False

    client.post(f"/internal/sessions/{sid}/skills", json={"name": "second"}, headers=H)
    auto = client.get(f"/api/sessions/{sid}/skills").get_json()["skills"]
    assert auto[0]["name"] == "second" and auto[0]["pinned"] is False


def test_unpinning_an_unknown_or_invalid_skill_is_404(client, builtin_root):
    write_skill(builtin_root, "good", "name: good\ndescription: 正常")
    sid = client.post("/api/sessions").get_json()["id"]
    assert client.delete(f"/api/sessions/{sid}/skills/nope/primary").status_code == 404
    # 没指定过也能调，幂等
    assert client.delete(f"/api/sessions/{sid}/skills/good/primary").status_code == 200


def test_naming_another_skill_takes_over_from_the_pinned_one(client, agent, builtin_root):
    write_skill(builtin_root, "lead", "name: lead\ndescription: 用户选的主导", body="# 主导正文")
    write_skill(builtin_root, "other", "name: other\ndescription: 另一个", body="# 另一个正文")
    sid = client.post("/api/sessions").get_json()["id"]
    for name in ("lead", "other"):
        client.post(f"/internal/sessions/{sid}/skills", json={"name": name}, headers=H)
    client.post(f"/api/sessions/{sid}/skills/lead/primary")

    # 用户改口点名别的 skill：指定让位，按最近使用排
    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    turn_id = _open_turn(client, sid, "/other 用这个")
    skills_ctx = _turn_skills(client, turn_id)
    assert [s["name"] for s in skills_ctx] == ["other", "lead"]
    assert [s["role"] for s in skills_ctx] == ["primary", "secondary"]
    assert skills_ctx[0]["pinned"] is False

    agent.released.set()
    _finish(client, turn_id)

    listed = client.get(f"/api/sessions/{sid}/skills").get_json()["skills"]
    assert listed[0]["name"] == "other" and listed[0]["pinned"] is False
