"""用户设置：模型连接、工具开关、skill 开关、自定义系统提示。存放在 settings 表（data/wren.db）。

api_key 只在内部接口里原样交给 agent；对外接口只返回是否已设置和末四位。
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any
from urllib.parse import urlparse

from .db import utcnow

THINKING_MODES = ("default", "enabled", "disabled")
REASONING_EFFORTS = ("", "low", "high", "max")

MODEL_DEFAULTS: dict[str, Any] = {
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-flash",
    "api_key": "",
    # default：不发送 thinking 参数，由服务端决定；enabled / disabled：显式发送。
    "thinking": "default",
    "reasoning_effort": "",
    # 单回合内最多调用模型几次（每次调用 = 一步，工具调用后会再调一次）。
    "max_steps": 8,
    # 送给模型的历史记录预算（估算 token）。超出时从最早的回合开始整回合丢弃。
    "history_budget_tokens": 32000,
}


class SettingsError(ValueError):
    pass


def _get(conn: sqlite3.Connection, key: str) -> Any:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else None


def _put(conn: sqlite3.Connection, key: str, value: Any) -> None:
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (key, json.dumps(value, ensure_ascii=False), utcnow()),
    )


# ---- model ----------------------------------------------------------------


def get_model(conn: sqlite3.Connection) -> dict[str, Any]:
    return {**MODEL_DEFAULTS, **(_get(conn, "model") or {})}


def public_model(conn: sqlite3.Connection) -> dict[str, Any]:
    model = get_model(conn)
    key = model.pop("api_key")
    model["api_key_set"] = bool(key)
    model["api_key_hint"] = f"…{key[-4:]}" if len(key) >= 8 else ""
    return model


def update_model(conn: sqlite3.Connection, patch: dict[str, Any]) -> dict[str, Any]:
    current = get_model(conn)
    unknown = set(patch) - set(MODEL_DEFAULTS)
    if unknown:
        raise SettingsError(f"未知字段：{', '.join(sorted(unknown))}")
    merged = {**current, **patch}
    # api_key 传空字符串表示「不修改」，传 null 表示清除。
    if patch.get("api_key") == "":
        merged["api_key"] = current["api_key"]
    elif "api_key" in patch and patch["api_key"] is None:
        merged["api_key"] = ""
    _validate_model(merged)
    _put(conn, "model", merged)
    return merged


def _validate_model(m: dict[str, Any]) -> None:
    url = urlparse(str(m["base_url"]))
    if url.scheme not in ("http", "https") or not url.netloc:
        raise SettingsError("base_url 必须是 http(s) 地址")
    m["base_url"] = str(m["base_url"]).rstrip("/")
    if not str(m["model"]).strip():
        raise SettingsError("model 不能为空")
    m["model"] = str(m["model"]).strip()
    m["api_key"] = str(m["api_key"]).strip()
    if m["thinking"] not in THINKING_MODES:
        raise SettingsError(f"thinking 只能是 {THINKING_MODES}")
    if m["reasoning_effort"] not in REASONING_EFFORTS:
        raise SettingsError(f"reasoning_effort 只能是 {REASONING_EFFORTS}")
    for field, low, high in (("max_steps", 1, 50), ("history_budget_tokens", 1000, 1_000_000)):
        value = m[field]
        if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
            raise SettingsError(f"{field} 必须是 {low}~{high} 之间的整数")


# ---- tools ----------------------------------------------------------------


def get_tool_switches(conn: sqlite3.Connection) -> dict[str, bool]:
    """工具开关。没出现在这里的工具按默认开启处理。"""
    return dict(_get(conn, "tools") or {})


def update_tool_switches(conn: sqlite3.Connection, patch: dict[str, Any]) -> dict[str, bool]:
    if not all(isinstance(k, str) and isinstance(v, bool) for k, v in patch.items()):
        raise SettingsError("工具开关格式应为 {工具名: true/false}")
    switches = {**get_tool_switches(conn), **patch}
    _put(conn, "tools", switches)
    return switches


# ---- skills ---------------------------------------------------------------


def get_skill_switches(conn: sqlite3.Connection) -> dict[str, bool]:
    """skill 开关。没出现在这里的 skill 按启用处理，新增的 skill 不用改配置。"""
    return dict(_get(conn, "skills") or {})


def update_skill_switches(conn: sqlite3.Connection, patch: dict[str, Any]) -> dict[str, bool]:
    if not all(isinstance(k, str) and isinstance(v, bool) for k, v in patch.items()):
        raise SettingsError("skill 开关格式应为 {skill 名: true/false}")
    switches = {**get_skill_switches(conn), **patch}
    _put(conn, "skills", switches)
    return switches


# ---- system prompt --------------------------------------------------------

SYSTEM_PROMPT_MAX = 8000


def get_system_prompt(conn: sqlite3.Connection) -> str:
    return _get(conn, "system_prompt") or ""


def update_system_prompt(conn: sqlite3.Connection, text: Any) -> str:
    if not isinstance(text, str):
        raise SettingsError("system_prompt 必须是字符串")
    if len(text) > SYSTEM_PROMPT_MAX:
        raise SettingsError(f"system_prompt 不能超过 {SYSTEM_PROMPT_MAX} 字")
    _put(conn, "system_prompt", text)
    return text
