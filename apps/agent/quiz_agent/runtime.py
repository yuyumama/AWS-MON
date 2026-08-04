"""AgentCore Runtime HTTP entrypoint.

AgentCore Runtime requires a containerized HTTP server on port 8080 with
POST /invocations and GET /ping endpoints.
"""

from __future__ import annotations

import os
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:

    def load_dotenv() -> bool:
        return False


from .guardrail import GroundingBlockedError
from .log_filters import suppress_duplicate_strands_warnings
from .server import (
    _as_json_bytes,
    _parse_body,
    build_generate_response,
    error_response,
    grounding_blocked_response,
    quota_exhausted_response,
)

AGENT_VERSION = "agentcore-runtime-v1"
KEEPALIVE_INTERVAL_SECONDS = 20.0


def _sse_data(body: object) -> bytes:
    """1行JSONのSSE dataイベントを生成する。"""
    return b"data: " + _as_json_bytes(body) + b"\n\n"


class RuntimeHandler(BaseHTTPRequestHandler):
    server_version = "aws-mon-agent-runtime/0.1"
    protocol_version = "HTTP/1.1"

    def _send_json(self, status: int, body: object) -> None:
        payload = _as_json_bytes(body)
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/ping":
            self._send_json(HTTPStatus.OK, {"status": "Healthy"})
            return
        self._send_json(
            HTTPStatus.NOT_FOUND, {"status": "error", "message": "not found"}
        )

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path != "/invocations":
            self._send_json(
                HTTPStatus.NOT_FOUND, {"status": "error", "message": "not found"}
            )
            return

        try:
            body = _parse_body(self)
        except Exception as exc:  # noqa: BLE001 - JSONエラーも現行どおりHTTP 200にする
            self._send_json(
                HTTPStatus.OK, error_response(exc, agent_version=AGENT_VERSION)
            )
            return

        started = time.perf_counter()
        if body.get("stream") is True:
            self._send_stream(body, started=started)
            return

        try:
            response = build_generate_response(
                body, started=started, agent_version=AGENT_VERSION
            )
            self._send_json(HTTPStatus.OK, response)
        except GroundingBlockedError as exc:
            self._send_json(
                HTTPStatus.OK,
                grounding_blocked_response(exc, agent_version=AGENT_VERSION),
            )
        except Exception as exc:  # noqa: BLE001 - AgentCore SDK maps non-200 to exceptions
            # .agent は重い依存(strands/mcp)を持つため、エラー時のみ遅延importする
            from .agent import QuotaExhaustedError

            if isinstance(exc, QuotaExhaustedError):
                self._send_json(
                    HTTPStatus.OK,
                    quota_exhausted_response(exc, agent_version=AGENT_VERSION),
                )
                return
            self._send_json(
                HTTPStatus.OK, error_response(exc, agent_version=AGENT_VERSION)
            )

    def _send_stream(self, body: dict[str, object], *, started: float) -> None:
        """フェーズと最終結果をSSEで返す。エラー時もHTTPステータスは200を維持する。"""
        self.send_response(HTTPStatus.OK)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()
        self.close_connection = True

        write_lock = threading.Lock()
        stopped = threading.Event()

        def write(payload: bytes) -> None:
            with write_lock:
                self.wfile.write(payload)
                self.wfile.flush()

        def keepalive() -> None:
            while not stopped.wait(KEEPALIVE_INTERVAL_SECONDS):
                try:
                    write(b": keepalive\n\n")
                except OSError:
                    stopped.set()
                    return

        keepalive_thread = threading.Thread(target=keepalive, daemon=True)
        keepalive_thread.start()

        def on_phase(phase: str, detail: dict[str, int]) -> None:
            write(
                _sse_data(
                    {
                        "type": "phase",
                        "phase": phase,
                        "attempt": detail["attempt"],
                        "totalAttempts": detail["totalAttempts"],
                    }
                )
            )

        try:
            try:
                result = build_generate_response(
                    body,
                    started=started,
                    agent_version=AGENT_VERSION,
                    on_phase=on_phase,
                )
            except GroundingBlockedError as exc:
                result = grounding_blocked_response(exc, agent_version=AGENT_VERSION)
            except Exception as exc:  # noqa: BLE001 - 終端resultへエラーを格納する
                from .agent import QuotaExhaustedError

                result = (
                    quota_exhausted_response(exc, agent_version=AGENT_VERSION)
                    if isinstance(exc, QuotaExhaustedError)
                    else error_response(exc, agent_version=AGENT_VERSION)
                )
            write(_sse_data({**result, "type": "result"}))
        finally:
            stopped.set()
            keepalive_thread.join(timeout=0.1)


def main() -> int:
    load_dotenv()
    suppress_duplicate_strands_warnings()
    host = os.environ.get("AGENT_RUNTIME_HOST", "0.0.0.0")
    port = int(os.environ.get("AGENT_RUNTIME_PORT", "8080"))
    server = ThreadingHTTPServer((host, port), RuntimeHandler)
    print(f"agent runtime listening on http://{host}:{port}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
