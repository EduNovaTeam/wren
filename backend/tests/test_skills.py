from __future__ import annotations

import sqlite3

from conftest import TOKEN, read_sse


def _session(client):
    return client.post("/api/sessions").get_json()["id"]


def _catalog(name="weekly-report", **overrides):
    item = {
        "name": name,
        "description": "写周报",
        "source": "builtin",
        "valid": True,
        "error": None,
        "allowed_tools": [],
        "missing_tools": [],
        "body_tokens": 10,
        "license": None,
        "compatibility": None,
    }
    item.update(overrides)
    return item


def _activate(client, sid, name, source="builtin", token=TOKEN):
    return client.put(
        f"/internal/sessions/{sid}/skills/{name}",
        json={"source": source},
        headers={"X-Wren-Internal-Token": token},
    )


def test_public_skill_list_merges_switches(client, agent):
    agent.skills = [
        _catalog("weekly-report"),
        _catalog("metrics-query", valid=False, error="依赖的工具未注册：run_sql"),
    ]
    body = client.get("/api/skills").get_json()
    assert [s["name"] for s in body["skills"]] == ["weekly-report", "metrics-query"]
    assert all(s["enabled"] for s in body["skills"])

    assert client.put("/api/skills", json={"weekly-report": False}).status_code == 200
    body = client.get("/api/skills").get_json()
    assert body["skills"][0]["enabled"] is False
    assert body["skills"][1]["error"] == "依赖的工具未注册：run_sql"


def test_skill_switch_validation(client):
    assert client.put("/api/skills", json={"Bad Name": False}).status_code == 400
    assert client.put("/api/skills", json={"ok": "no"}).status_code == 400
    assert client.put("/api/skills", json=["ok"]).status_code == 400


def test_public_skill_list_fails_clearly_when_agent_is_down(client, app):
    app.config["WREN"] = app.config["WREN"].__class__(
        **{**app.config["WREN"].__dict__, "agent_url": "http://127.0.0.1:9"}
    )
    resp = client.get("/api/skills")
    assert resp.status_code == 502
    assert "无法从 agent 获取 Skill 列表" in resp.get_json()["error"]


def test_activation_is_persisted_and_idempotent(client):
    sid = _session(client)
    first = _activate(client, sid, "weekly-report")
    assert first.status_code == 201
    activated_at = first.get_json()["activated_at"]

    second = _activate(client, sid, "weekly-report", source="user")
    assert second.status_code == 201
    assert second.get_json()["activated_at"] == activated_at
    assert second.get_json()["source"] == "user"

    state = client.get(
        f"/internal/sessions/{sid}/skills/state", headers={"X-Wren-Internal-Token": TOKEN}
    ).get_json()
    assert len(state["active_skills"]) == 1
    assert state["active_skills"][0]["name"] == "weekly-report"
    assert state["active_skills"][0]["source"] == "user"
    assert state["skill_switches"] == {}
    assert state["tool_switches"] == {}


def test_internal_skill_endpoints_require_token(client):
    sid = _session(client)
    resp = client.put(f"/internal/sessions/{sid}/skills/x", json={"source": "builtin"})
    assert resp.status_code == 401
    assert client.get(f"/internal/sessions/{sid}/skills/state").status_code == 401
    assert _activate(client, sid, "x", source="somewhere").status_code == 400
    assert _activate(client, 999, "x").status_code == 404
    assert _activate(client, sid, "Bad Name").status_code == 400


def test_session_skill_status_reports_invalid_disabled_and_missing(client, agent):
    agent.skills = [
        _catalog("weekly-report"),
        _catalog("broken", valid=False, error="依赖的工具未注册：run_sql"),
    ]
    sid = _session(client)
    for name in ("weekly-report", "broken", "gone"):
        assert _activate(client, sid, name).status_code == 201
    client.put("/api/skills", json={"weekly-report": False})

    rows = client.get(f"/api/sessions/{sid}/skills").get_json()["skills"]
    by_name = {row["name"]: row for row in rows}
    assert by_name["weekly-report"]["status"] == "disabled"
    assert "全局停用" in by_name["weekly-report"]["error"]
    assert by_name["broken"]["status"] == "invalid"
    assert "run_sql" in by_name["broken"]["error"]
    assert by_name["gone"]["status"] == "missing"


def test_session_skill_status_degrades_when_agent_is_down(client, agent, app):
    sid = _session(client)
    _activate(client, sid, "weekly-report")
    app.config["WREN"] = app.config["WREN"].__class__(
        **{**app.config["WREN"].__dict__, "agent_url": "http://127.0.0.1:9"}
    )
    rows = client.get(f"/api/sessions/{sid}/skills").get_json()["skills"]
    assert rows[0]["status"] == "unknown"
    assert rows[0]["name"] == "weekly-report"


def test_remove_session_skill(client):
    sid = _session(client)
    _activate(client, sid, "weekly-report")
    assert client.delete(f"/api/sessions/{sid}/skills/weekly-report").status_code == 204
    assert client.delete(f"/api/sessions/{sid}/skills/weekly-report").status_code == 404
    assert client.get(f"/api/sessions/{sid}/skills").get_json()["skills"] == []


def test_deleting_session_cascades_skill_activations(client, app):
    sid = _session(client)
    _activate(client, sid, "weekly-report")
    assert client.delete(f"/api/sessions/{sid}").status_code == 204
    conn = sqlite3.connect(app.config["WREN"].db_path)
    try:
        count = conn.execute("SELECT COUNT(*) FROM session_skills").fetchone()[0]
    finally:
        conn.close()
    assert count == 0


def test_turn_context_carries_skill_switches_and_activations(client, agent):
    agent.script = [{"type": "_hold"}, {"type": "turn_end", "status": "done"}]
    sid = _session(client)
    _activate(client, sid, "weekly-report")
    client.put("/api/skills", json={"weekly-report": False})
    created = client.post(f"/api/sessions/{sid}/turns", json={"content": "hi"}).get_json()
    turn_id = created["turn_id"]

    ctx = client.get(
        f"/internal/turns/{turn_id}/context", headers={"X-Wren-Internal-Token": TOKEN}
    ).get_json()
    assert ctx["skill_switches"] == {"weekly-report": False}
    assert ctx["active_skills"][0]["name"] == "weekly-report"
    agent.released.set()
    read_sse(client.get(f"/api/turns/{turn_id}/events"))
