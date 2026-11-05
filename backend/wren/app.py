"""Flask 应用工厂。

新增一组接口：在 `wren/api/` 下写一个蓝图模块，再加进下面的 BLUEPRINTS。
"""

from __future__ import annotations

import logging
from pathlib import Path

from flask import Flask, jsonify, send_from_directory
from werkzeug.exceptions import HTTPException

from . import store
from .api import chat, close_db, internal, notes_api, settings_api, skills_api
from .config import REPO_ROOT, Config
from .db import connect, migrate
from .turns import TurnRegistry

BLUEPRINTS = [
    chat.bp,
    settings_api.bp,
    internal.bp,
    notes_api.bp,
    notes_api.internal_bp,
    skills_api.bp,
    skills_api.internal_bp,
]

WEB_DIST = REPO_ROOT / "web" / "dist"


def create_app(cfg: Config | None = None) -> Flask:
    cfg = cfg or Config.from_env()
    app = Flask(__name__, static_folder=None)
    app.config["WREN"] = cfg
    app.extensions["wren_turns"] = TurnRegistry()

    conn = connect(cfg.db_path)
    try:
        applied = migrate(conn)
        orphans = store.fail_orphan_turns(conn)
    finally:
        conn.close()
    if applied:
        app.logger.info("已执行迁移：%s", ", ".join(applied))
    if orphans:
        app.logger.warning("%d 个上次未结束的回合已标记为失败", orphans)
    app.teardown_appcontext(close_db)

    for bp in BLUEPRINTS:
        app.register_blueprint(bp)

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.errorhandler(HTTPException)
    def http_error(exc: HTTPException):
        return jsonify(error=exc.description), exc.code

    _serve_built_web(app, WEB_DIST)
    return app


def _serve_built_web(app: Flask, dist: Path) -> None:
    """有构建产物时由后端直接托管前端（`npm run build` 之后）；开发时走 Vite。"""

    @app.get("/", defaults={"path": ""})
    @app.get("/<path:path>")
    def web(path: str):
        if not dist.is_dir():
            return (
                "前端未构建。开发时请访问 Vite 地址（默认 http://127.0.0.1:5173）。",
                404,
            )
        target = dist / path
        if path and target.is_file():
            return send_from_directory(dist, path)
        return send_from_directory(dist, "index.html")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    cfg = Config.from_env()
    app = create_app(cfg)
    # 回合运行器在进程内存里，必须单进程；threaded=True 让 SSE 与普通请求并行。
    app.run(host=cfg.host, port=cfg.port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
