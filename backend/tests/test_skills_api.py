"""技能设置与会话持久化 API 测试。"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from wren import store
from wren.app import create_app
from wren.db import connect

TOKEN = "test-token"

SKILL_MD = """---
name: {name}
description: {desc}
allowed-tools: echo
---

{body}
"""


def write_skill(root: Path, name: str, *, desc: str = "示例技能", body: str = "技能正文") -> None:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(SKILL_MD.format(name=name, desc=desc, body=body), encoding="utf-8")
    (d / "notes.txt").write_text("资源内容", encoding="utf-8")


@pytest.fixture
def skills_dirs(tmp_path):
    builtin = tmp_path / "builtin-skills"
    user = tmp_path / "user-skills"
    builtin.mkdir()
    user.mkdir()
    write_skill(builtin, "alpha", desc="内置甲", body="ALPHA-BODY")
    write_skill(user, "beta", desc="用户乙", body="BETA-BODY")
    # 无效技能：缺 name 或格式坏
    bad = user / "broken"
    bad.mkdir()
    (bad / "SKILL.md").write_text("not: [valid", encoding="utf-8")
    return builtin, user


@pytest.fixture
def app(cfg, skills_dirs):
    builtin, user = skills_dirs
    cfg2 = replace(cfg, builtin_skills_dir=builtin, user_skills_dir=user)
    return create_app(cfg2)


@pytest.fixture
def client(app):
    return app.test_client()


def make_running_turn(cfg, app) -> tuple[int, int]:
    conn = connect(cfg.db_path)
    try:
        sess = store.create_session(conn)
        turn = store.start_turn(conn, sess["id"], "你好")
        return sess["id"], turn["turn_id"]
    finally:
        conn.close()


def finish_turn(cfg, turn_id: int, status: str = "done") -> None:
    conn = connect(cfg.db_path)
    try:
        conn.execute(
            "UPDATE turns SET status = ?, finished_at = datetime('now') WHERE id = ?",
            (status, turn_id),
        )
        conn.commit()
    finally:
        conn.close()


def test_list_merges_enabled_and_no_body(client):
    res = client.get("/api/settings/skills")
    assert res.status_code == 200
    data = res.get_json()["skills"]
    by_name = {s["name"]: s for s in data}
    assert set(by_name) == {"alpha", "beta", "broken"}
    assert by_name["alpha"]["source"] == "builtin"
    assert by_name["beta"]["source"] == "user"
    assert by_name["alpha"]["enabled"] is True
    assert by_name["broken"]["valid"] is False
    assert by_name["broken"]["error"]
    for s in data:
        assert "body" not in s


def test_switches_validation_atomic(client):
    assert client.put("/api/settings/skills", json={"nope": False}).status_code == 400
    assert client.put("/api/settings/skills", json={"alpha": 1}).status_code == 400
    assert client.put("/api/settings/skills", json=[1]).status_code == 400
    # 无效技能不能启用
    assert client.put("/api/settings/skills", json={"broken": True}).status_code == 400
    # 原子：一个坏键导致全部不生效
    assert client.put("/api/settings/skills", json={"alpha": False, "x": False}).status_code == 400
    data = client.get("/api/settings/skills").get_json()["skills"]
    assert {s["name"]: s["enabled"] for s in data}["alpha"] is True


def test_switches_persist_across_restart(cfg, skills_dirs):
    builtin, user = skills_dirs
    cfg2 = replace(cfg, builtin_skills_dir=builtin, user_skills_dir=user)
    app1 = create_app(cfg2)
    c1 = app1.test_client()
    res = c1.put("/api/settings/skills", json={"beta": False})
    assert res.status_code == 200
    # 无效技能允许关闭
    assert c1.put("/api/settings/skills", json={"broken": False}).status_code == 200
    app2 = create_app(cfg2)
    c2 = app2.test_client()
    data = {s["name"]: s["enabled"] for s in c2.get("/api/settings/skills").get_json()["skills"]}
    assert data["beta"] is False
    assert data["broken"] is False


def test_internal_requires_token(client):
    sess_id, turn_id = make_running_turn_cfg(client.application.config["WREN"], client.application)
    res = client.post(f"/internal/turns/{turn_id}/skills/alpha/activate")
    assert res.status_code == 401
    res = client.post(
        f"/internal/turns/{turn_id}/skills/alpha/activate",
        headers={"X-Wren-Internal-Token": TOKEN},
    )
    assert res.status_code == 200


def test_activate_idempotent_and_context(client):
    cfg = client.application.config["WREN"]
    sess_id, turn_id = make_running_turn_cfg(cfg, client.application)
    headers = {"X-Wren-Internal-Token": TOKEN}
    r1 = client.post(f"/internal/turns/{turn_id}/skills/alpha/activate", headers=headers)
    assert r1.status_code == 200
    assert r1.get_json()["skill"]["body"].strip() == "ALPHA-BODY"
    r2 = client.post(f"/internal/turns/{turn_id}/skills/alpha/activate", headers=headers)
    assert r2.status_code == 200
    active = client.get(f"/api/sessions/{sess_id}/skills").get_json()["skills"]
    assert [s["name"] for s in active] == ["alpha"]
    assert "body" not in active[0]
    ctx = client.get(f"/internal/turns/{turn_id}/context", headers=headers).get_json()
    assert ctx["skills"]["active"] == [{**r1.get_json()["skill"]}]
    names = {s["name"] for s in ctx["skills"]["available"]}
    assert names == {"alpha", "beta"}  # broken 被过滤
    for s in ctx["skills"]["available"]:
        assert "body" not in s


def test_activate_errors(client):
    cfg = client.application.config["WREN"]
    headers = {"X-Wren-Internal-Token": TOKEN}
    sess_id, turn_id = make_running_turn_cfg(cfg, client.application)
    assert (
        client.post("/internal/turns/99999/skills/alpha/activate", headers=headers).status_code
        == 404
    )
    assert (
        client.post(
            f"/internal/turns/{turn_id}/skills/broken/activate", headers=headers
        ).status_code
        == 400
    )
    finish_turn(cfg, turn_id, "done")
    assert (
        client.post(f"/internal/turns/{turn_id}/skills/alpha/activate", headers=headers).status_code
        == 409
    )


def test_session_isolation(client):
    cfg = client.application.config["WREN"]
    headers = {"X-Wren-Internal-Token": TOKEN}
    s1, t1 = make_running_turn_cfg(cfg, client.application)
    s2, t2 = make_running_turn_cfg(cfg, client.application)
    assert (
        client.post(f"/internal/turns/{t1}/skills/alpha/activate", headers=headers).status_code
        == 200
    )
    assert client.get(f"/api/sessions/{s2}/skills").get_json()["skills"] == []


def test_resource_requires_active(client):
    cfg = client.application.config["WREN"]
    headers = {"X-Wren-Internal-Token": TOKEN}
    sess_id, turn_id = make_running_turn_cfg(cfg, client.application)
    body = {"path": "notes.txt"}
    res = client.post(
        f"/internal/turns/{turn_id}/skills/alpha/resource", json=body, headers=headers
    )
    assert res.status_code == 400
    client.post(f"/internal/turns/{turn_id}/skills/alpha/activate", headers=headers)
    ok = client.post(f"/internal/turns/{turn_id}/skills/alpha/resource", json=body, headers=headers)
    assert ok.status_code == 200
    assert ok.get_json()["content"] == "资源内容"
    # 越界
    bad = client.post(
        f"/internal/turns/{turn_id}/skills/alpha/resource",
        json={"path": "../beta/SKILL.md"},
        headers=headers,
    )
    assert bad.status_code == 400
    # 停用后失败
    assert client.put("/api/settings/skills", json={"alpha": False}).status_code == 200
    assert (
        client.post(
            f"/internal/turns/{turn_id}/skills/alpha/resource", json=body, headers=headers
        ).status_code
        == 400
    )


def test_disable_drops_activation_and_no_restore(client):
    cfg = client.application.config["WREN"]
    headers = {"X-Wren-Internal-Token": TOKEN}
    sess_id, turn_id = make_running_turn_cfg(cfg, client.application)
    client.post(f"/internal/turns/{turn_id}/skills/alpha/activate", headers=headers)
    finish_turn(cfg, turn_id)
    assert client.put("/api/settings/skills", json={"alpha": False}).status_code == 200
    assert client.get(f"/api/sessions/{sess_id}/skills").get_json()["skills"] == []
    client.put("/api/settings/skills", json={"alpha": True})
    assert client.get(f"/api/sessions/{sess_id}/skills").get_json()["skills"] == []


def test_active_skill_survives_restart_and_history_budget(client):
    cfg = client.application.config["WREN"]
    sid, tid = make_running_turn(cfg, client.application)
    headers = {"X-Wren-Internal-Token": TOKEN}
    assert (
        client.post(f"/internal/turns/{tid}/skills/alpha/activate", headers=headers).status_code
        == 200
    )
    finish_turn(cfg, tid)
    restarted = create_app(cfg).test_client()
    conn = connect(cfg.db_path)
    try:
        second = store.start_turn(conn, sid, "再精简一点")["turn_id"]
    finally:
        conn.close()
    ctx = restarted.get(f"/internal/turns/{second}/context", headers=headers).get_json()
    assert [s["name"] for s in ctx["skills"]["active"]] == ["alpha"]
    assert "BETA-BODY" not in str(ctx["skills"])
    assert restarted.get(f"/api/sessions/{sid}/skills").get_json()["skills"][0]["name"] == "alpha"


def test_delete_session_cascades(client):
    cfg = client.application.config["WREN"]
    headers = {"X-Wren-Internal-Token": TOKEN}
    sess_id, turn_id = make_running_turn_cfg(cfg, client.application)
    client.post(f"/internal/turns/{turn_id}/skills/alpha/activate", headers=headers)
    finish_turn(cfg, turn_id)
    conn = connect(cfg.db_path)
    try:
        store.delete_session(conn, sess_id)
    finally:
        conn.close()
    conn = connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM session_skills WHERE session_id = ?", (sess_id,)
        ).fetchone()
        assert row["n"] == 0
    finally:
        conn.close()


def test_delete_while_running_conflict(client):
    cfg = client.application.config["WREN"]
    headers = {"X-Wren-Internal-Token": TOKEN}
    sess_id, turn_id = make_running_turn_cfg(cfg, client.application)
    client.post(f"/internal/turns/{turn_id}/skills/alpha/activate", headers=headers)
    res = client.delete(f"/api/sessions/{sess_id}/skills/alpha")
    assert res.status_code == 409


def test_session_endpoints_404(client):
    assert client.get("/api/sessions/99999/skills").status_code == 404
    assert client.delete("/api/sessions/99999/skills/alpha").status_code == 404


def test_bad_json_body(client):
    res = client.put("/api/settings/skills", data="x", content_type="application/json")
    assert res.status_code == 400


# store.start_turn 需要在测试结束后把 running 回合收尾，避免 app 工厂 fail_orphan 影响其他用例。
def make_running_turn_cfg(cfg, app) -> tuple[int, int]:
    return make_running_turn(cfg, app)


@pytest.fixture(autouse=True)
def _cleanup_running(cfg, app):
    yield
    conn = connect(cfg.db_path)
    try:
        conn.execute("UPDATE turns SET status = 'stopped' WHERE status = 'running'")
        conn.commit()
    finally:
        conn.close()
