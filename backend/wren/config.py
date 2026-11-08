"""运行配置：全部来自环境变量（`scripts/dev.mjs` 会读取根目录的 .env 再传进来）。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Config:
    data_dir: Path
    agent_url: str
    internal_token: str
    host: str = "127.0.0.1"
    port: int = 5280
    # 单个回合从 agent 读事件流的最长静默时间（秒）。模型思考期间 agent 会持续发事件，
    # 超过这个时间没有任何字节，视为 agent 失联。
    agent_read_timeout: float = 180.0
    # 内置技能目录（随仓库发布）。
    builtin_skills_dir: Path = REPO_ROOT / "skills"
    # 用户技能目录；为 None 时使用 data_dir / "skills"。
    user_skills_dir: Path | None = None

    @property
    def db_path(self) -> Path:
        return self.data_dir / "wren.db"

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Config:
        env = dict(os.environ if env is None else env)
        token = env.get("WREN_INTERNAL_TOKEN", "").strip()
        if not token:
            raise RuntimeError(
                "WREN_INTERNAL_TOKEN 未设置：后端与 agent 之间的内部接口需要共享口令。"
                "用 `node scripts/dev.mjs` 启动会自动生成；单独启动时请自行设置。"
            )
        agent_port = env.get("WREN_AGENT_PORT", "5281")
        data_dir = Path(env.get("WREN_DATA_DIR") or REPO_ROOT / "data")
        skills_dir = env.get("WREN_SKILLS_DIR", "").strip()
        return cls(
            data_dir=data_dir.resolve(),
            agent_url=env.get("WREN_AGENT_URL") or f"http://127.0.0.1:{agent_port}",
            internal_token=token,
            port=int(env.get("WREN_BACKEND_PORT", "5280")),
            user_skills_dir=Path(skills_dir).resolve() if skills_dir else None,
        )
