from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from wren.app import create_app
from wren.config import Config

TOKEN = "test-token"


class FakeAgent:
    """替身 agent：按脚本回放 NDJSON 事件，记录收到的请求。"""

    def __init__(self) -> None:
        self.script: list[dict] = []
        self.hold = threading.Event()  # 设置后，回放到 {"type": "_hold"} 时阻塞，直到 release
        self.released = threading.Event()
        self.aborted: list[int] = []
        self.requests: list[dict] = []
        self.tools = [{"name": "echo", "description": "回显", "toggleable": True}]
        self.skills: list[dict] = []
        agent = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # 安静
                pass

            def _json(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == "/tools":
                    self._json(200, {"tools": agent.tools})
                elif self.path == "/skills":
                    self._json(200, {"skills": agent.skills, "errors": []})
                else:
                    self._json(404, {})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                agent.requests.append(
                    {
                        "path": self.path,
                        "body": body,
                        "token": self.headers.get("X-Wren-Internal-Token"),
                    }
                )
                if self.path.endswith("/abort"):
                    agent.aborted.append(int(self.path.split("/")[2]))
                    agent.released.set()
                    self._json(200, {"ok": True})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.end_headers()
                for event in agent.script:
                    if event.get("type") == "_hold":
                        agent.released.wait(10)
                        continue
                    self.wfile.write((json.dumps(event) + "\n").encode())
                    self.wfile.flush()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.released.set()
        self.server.shutdown()


@pytest.fixture
def agent():
    fake = FakeAgent()
    yield fake
    fake.close()


@pytest.fixture
def cfg(tmp_path, agent):
    return Config(data_dir=tmp_path, agent_url=agent.url, internal_token=TOKEN)


@pytest.fixture
def app(cfg):
    return create_app(cfg)


@pytest.fixture
def client(app):
    return app.test_client()


def read_sse(response) -> list[dict]:
    events = []
    for chunk in response.response:
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        for frame in text.split("\n\n"):
            if frame.startswith("data: "):
                events.append(json.loads(frame[6:]))
    return events
