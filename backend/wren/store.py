"""会话 / 回合 / 消息的数据访问。所有函数都接收一个 sqlite3 连接，自身不持有状态。"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .db import transaction, utcnow

TITLE_MAX = 40
FINISHED = ("done", "stopped", "failed")


def _session(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row)


def _message(row: sqlite3.Row) -> dict[str, Any]:
    """数据库行 → OpenAI Chat Completions 形状的 message（只带非空字段）。"""
    msg: dict[str, Any] = {"id": row["id"], "role": row["role"], "content": row["content"]}
    if row["reasoning_content"] is not None:
        msg["reasoning_content"] = row["reasoning_content"]
    if row["tool_calls"]:
        msg["tool_calls"] = json.loads(row["tool_calls"])
    if row["tool_call_id"]:
        msg["tool_call_id"] = row["tool_call_id"]
    if row["name"]:
        msg["name"] = row["name"]
    return msg


# ---- sessions -------------------------------------------------------------


def create_session(conn: sqlite3.Connection, title: str = "") -> dict[str, Any]:
    now = utcnow()
    cur = conn.execute(
        "INSERT INTO sessions (title, created_at, updated_at) VALUES (?, ?, ?)",
        (title[:TITLE_MAX], now, now),
    )
    return get_session(conn, cur.lastrowid)  # type: ignore[return-value]


def get_session(conn: sqlite3.Connection, session_id: int) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return _session(row) if row else None


def list_sessions(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM sessions ORDER BY updated_at DESC, id DESC").fetchall()
    return [_session(r) for r in rows]


def rename_session(conn: sqlite3.Connection, session_id: int, title: str) -> bool:
    cur = conn.execute(
        "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
        (title.strip()[:TITLE_MAX], utcnow(), session_id),
    )
    return cur.rowcount > 0


def delete_session(conn: sqlite3.Connection, session_id: int) -> bool:
    return conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,)).rowcount > 0


# ---- session skills -------------------------------------------------------


def activate_skill(
    conn: sqlite3.Connection, session_id: int, name: str, *, explicit: bool = True
) -> None:
    """把 skill 记为会话级生效，并刷新它的「最近使用」时间。

    `explicit` 区分来源：用户 `/名字` 点名（True）会清掉「已退出」的标记，并解除别的
    skill 上的「主导」指定——用户开口要换，就按新说的来；模型自己读到正文（False）
    只在该 skill 没被退出过时才生效，也不动主导。
    """
    now = utcnow()
    if explicit:
        conn.execute(
            "UPDATE session_skills SET pinned_at = NULL"
            " WHERE session_id = ? AND skill_name <> ?",
            (session_id, name),
        )
        conn.execute(
            "INSERT INTO session_skills"
            " (session_id, skill_name, activated_at, last_used_at, suppressed_at)"
            " VALUES (?, ?, ?, ?, NULL)"
            " ON CONFLICT(session_id, skill_name)"
            " DO UPDATE SET suppressed_at = NULL, last_used_at = excluded.last_used_at",
            (session_id, name, now, now),
        )
        return
    # 模型读了一遍＝正在用这个 skill：刷新时间，没指定主导时它会浮到最前。
    # 但被用户退出过的行不动，否则读一次就复活了。
    refreshed = conn.execute(
        "UPDATE session_skills SET last_used_at = ?"
        " WHERE session_id = ? AND skill_name = ? AND suppressed_at IS NULL",
        (now, session_id, name),
    )
    if refreshed.rowcount:
        return
    conn.execute(
        "INSERT OR IGNORE INTO session_skills"
        " (session_id, skill_name, activated_at, last_used_at)"
        " VALUES (?, ?, ?, ?)",
        (session_id, name, now, now),
    )


def mark_primary(conn: sqlite3.Connection, session_id: int, name: str) -> None:
    """用户在界面上指定「主导」。这个选择要一直有效，直到用户再点名别的 skill。"""
    now = utcnow()
    conn.execute(
        "UPDATE session_skills SET pinned_at = NULL WHERE session_id = ? AND skill_name <> ?",
        (session_id, name),
    )
    conn.execute(
        "INSERT INTO session_skills"
        " (session_id, skill_name, activated_at, last_used_at, pinned_at, suppressed_at)"
        " VALUES (?, ?, ?, ?, ?, NULL)"
        " ON CONFLICT(session_id, skill_name)"
        " DO UPDATE SET pinned_at = excluded.pinned_at,"
        " last_used_at = excluded.last_used_at, suppressed_at = NULL",
        (session_id, name, now, now, now),
    )


def deactivate_skill(conn: sqlite3.Connection, session_id: int, name: str) -> bool:
    """用户退出一个 skill 的会话级生效。保留记录并打标记，见 `activate_skill`。"""
    now = utcnow()
    cur = conn.execute(
        "INSERT INTO session_skills (session_id, skill_name, activated_at, suppressed_at)"
        " VALUES (?, ?, ?, ?)"
        " ON CONFLICT(session_id, skill_name) DO UPDATE SET suppressed_at = excluded.suppressed_at",
        (session_id, name, now, now),
    )
    return cur.rowcount > 0


def session_skills(conn: sqlite3.Connection, session_id: int) -> list[str]:
    """返回会话里生效中的 skill 名。用户指定的主导排最前，其余按最近使用排。"""
    rows = conn.execute(
        "SELECT skill_name FROM session_skills WHERE session_id = ? AND suppressed_at IS NULL"
        " ORDER BY (pinned_at IS NULL), COALESCE(last_used_at, activated_at) DESC, skill_name",
        (session_id,),
    ).fetchall()
    return [row["skill_name"] for row in rows]


def pinned_skill(conn: sqlite3.Connection, session_id: int) -> str | None:
    """用户明确指定为主导的 skill（没有则为 None）。

    它和「最近使用」不是一回事：模型读一次别的 skill 会刷新那个的最近使用时间，
    但不能因此把用户点的这个换掉。
    """
    row = conn.execute(
        "SELECT skill_name FROM session_skills"
        " WHERE session_id = ? AND pinned_at IS NOT NULL AND suppressed_at IS NULL"
        " ORDER BY pinned_at DESC LIMIT 1",
        (session_id,),
    ).fetchone()
    return row["skill_name"] if row else None


def suppressed_skills(conn: sqlite3.Connection, session_id: int) -> list[str]:
    """用户在这个会话里退出过的 skill。

    这些 skill 连清单都不该出现：否则模型翻到它、读一遍正文，这个回合又照着做了，
    用户点的退出等于没点。
    """
    rows = conn.execute(
        "SELECT skill_name FROM session_skills WHERE session_id = ? AND suppressed_at IS NOT NULL",
        (session_id,),
    ).fetchall()
    return [row["skill_name"] for row in rows]


# ---- turns ----------------------------------------------------------------


def running_turn(conn: sqlite3.Connection, session_id: int) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM turns WHERE session_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
        (session_id,),
    ).fetchone()
    return dict(row) if row else None


def get_turn(conn: sqlite3.Connection, turn_id: int) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM turns WHERE id = ?", (turn_id,)).fetchone()
    return dict(row) if row else None


def start_turn(conn: sqlite3.Connection, session_id: int, user_content: str) -> dict[str, Any]:
    """建回合并写入用户消息。同一会话已有进行中的回合时抛 TurnConflict。"""
    now = utcnow()
    with transaction(conn):
        if running_turn(conn, session_id):
            raise TurnConflict(session_id)
        turn_id = conn.execute(
            "INSERT INTO turns (session_id, status, started_at) VALUES (?, 'running', ?)",
            (session_id, now),
        ).lastrowid
        msg_id = conn.execute(
            "INSERT INTO messages (session_id, turn_id, role, content, created_at)"
            " VALUES (?, ?, 'user', ?, ?)",
            (session_id, turn_id, user_content, now),
        ).lastrowid
        conn.execute(
            "UPDATE sessions SET updated_at = ?,"
            " title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?",
            (now, _title_from(user_content), session_id),
        )
    return {"turn_id": turn_id, "user_message_id": msg_id}


def add_message(
    conn: sqlite3.Connection, session_id: int, turn_id: int, msg: dict[str, Any]
) -> int:
    role = msg.get("role")
    if role not in ("assistant", "tool"):
        raise ValueError(f"agent 只能写入 assistant / tool 消息，收到 {role!r}")
    tool_calls = msg.get("tool_calls") or None
    cur = conn.execute(
        "INSERT INTO messages (session_id, turn_id, role, content, reasoning_content,"
        " tool_calls, tool_call_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            session_id,
            turn_id,
            role,
            msg.get("content") or "",
            msg.get("reasoning_content"),
            json.dumps(tool_calls, ensure_ascii=False) if tool_calls else None,
            msg.get("tool_call_id"),
            msg.get("name"),
            utcnow(),
        ),
    )
    return cur.lastrowid  # type: ignore[return-value]


def finish_turn(
    conn: sqlite3.Connection,
    turn_id: int,
    status: str,
    error: str | None = None,
    usage: dict[str, Any] | None = None,
) -> bool:
    """把回合从 running 迁到终态。只迁一次：已是终态的回合不会被覆盖。"""
    if status not in FINISHED:
        raise ValueError(status)
    now = utcnow()
    with transaction(conn):
        cur = conn.execute(
            "UPDATE turns SET status = ?, error = ?, usage = ?, finished_at = ?"
            " WHERE id = ? AND status = 'running'",
            (status, error, json.dumps(usage) if usage else None, now, turn_id),
        )
        if cur.rowcount:
            conn.execute(
                "UPDATE sessions SET updated_at = ?"
                " WHERE id = (SELECT session_id FROM turns WHERE id = ?)",
                (now, turn_id),
            )
    return cur.rowcount > 0


def fail_orphan_turns(conn: sqlite3.Connection) -> int:
    """进程启动时调用：上次运行遗留的 running 回合不可能再有人推进，统一标记失败。"""
    cur = conn.execute(
        "UPDATE turns SET status = 'failed', error = '服务重启，回合中断', finished_at = ?"
        " WHERE status = 'running'",
        (utcnow(),),
    )
    return cur.rowcount


def list_turns(conn: sqlite3.Connection, session_id: int) -> list[dict[str, Any]]:
    """给界面用：按时间顺序的回合，每个回合带自己的消息。"""
    turns = [
        _turn(r)
        for r in conn.execute(
            "SELECT * FROM turns WHERE session_id = ? ORDER BY id", (session_id,)
        ).fetchall()
    ]
    by_id = {t["id"]: t for t in turns}
    for row in conn.execute(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY id", (session_id,)
    ).fetchall():
        by_id[row["turn_id"]]["messages"].append(_message(row))
    return turns


def history(conn: sqlite3.Connection, session_id: int, before_turn: int) -> list[dict[str, Any]]:
    """给 agent 用：某回合之前所有已结束回合的完整记录。截断由 agent 按预算决定。"""
    turns = [t for t in list_turns(conn, session_id) if t["id"] < before_turn]
    out = []
    for t in turns:
        if t["status"] == "running":
            continue
        msgs = [{k: v for k, v in m.items() if k != "id"} for m in t["messages"]]
        out.append({"turn_id": t["id"], "status": t["status"], "messages": msgs})
    return out


def _turn(row: sqlite3.Row) -> dict[str, Any]:
    turn = dict(row)
    turn["usage"] = json.loads(turn["usage"]) if turn["usage"] else None
    turn["messages"] = []
    return turn


def _title_from(text: str) -> str:
    line = " ".join(text.split())
    return line[:TITLE_MAX]


class TurnConflict(Exception):
    def __init__(self, session_id: int):
        super().__init__(f"会话 {session_id} 已有进行中的回合")
        self.session_id = session_id
