from __future__ import annotations

from pathlib import Path

import pytest
from conftest import TOKEN, read_sse

from wren import skills

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


def _cfg(data_dir: Path):
    from wren.config import Config

    return Config(data_dir=data_dir, agent_url="http://127.0.0.1:1", internal_token=TOKEN)
