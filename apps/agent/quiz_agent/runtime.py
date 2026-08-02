"""AgentCore Runtime HTTP entrypoint.

AgentCore Runtime requires a containerized HTTP server on port 8080 with
POST /invocations and GET /ping endpoints.
"""

from __future__ import annotations

import os
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


class RuntimeHandler(BaseHTTPRequestHandler):
    server_version = "aws-mon-agent-runtime/0.1"

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

        started = time.perf_counter()
        try:
            body = _parse_body(self)
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
