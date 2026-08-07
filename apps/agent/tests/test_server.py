from __future__ import annotations

import io
import json
from http import HTTPStatus
from typing import Any

import pytest

from quiz_agent import runtime as runtime_module
from quiz_agent import server as server_module
from quiz_agent.agent import (
    QuotaExhaustedError,
    ResearchFailedError,
    ResearchIncompleteError,
)
from quiz_agent.content_policy import ContentPolicyViolationError
from quiz_agent.guardrail import GateResult
from quiz_agent.schema import QuizItem


class _FakeHandler:
    """BaseHTTPRequestHandler.do_POST を実際のソケットなしで検証するための代役。"""

    path = "/generate"

    def __init__(self) -> None:
        self.sent: tuple[int, Any] | None = None

    def _send_json(self, status: int, body: object) -> None:
        self.sent = (status, body)


def test_quiz_item_schema_includes_summary() -> None:
    schema = QuizItem.model_json_schema()

    assert "summary" in schema["properties"]
    assert "summary" in schema["required"]


def test_build_generate_response_includes_summary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    item = QuizItem.model_validate(
        {
            "summary": "クロスリージョン推論による可用性向上",
            "question": {
                "type": "single",
                "question": "設問",
                "options": [
                    {"label": "A", "text": "正解"},
                    {"label": "B", "text": "不正解"},
                ],
                "correct": ["A"],
            },
            "explanation": {
                "overview": "概要",
                "correct_reason": "正解の理由",
                "grounding_claim_en": (
                    "The correct option matches the documented AWS behavior. "
                    "It applies the capability described in the source."
                ),
                "option_reasons": [
                    {"label": "A", "reason": "正しい"},
                    {"label": "B", "reason": "誤り"},
                ],
                "source": "https://docs.aws.amazon.com/example",
            },
        }
    )
    monkeypatch.setattr(
        server_module,
        "_generate_quiz",
        lambda **kwargs: (item, GateResult(status="not_run")),
    )

    response = server_module.build_generate_response({}, started=0)

    assert response["quiz"]["summary"] == item.summary


class _StreamFakeHandler:
    """SSE応答のヘッダと本体を記録する代役。"""

    path = "/invocations"
    _send_stream = runtime_module.RuntimeHandler._send_stream

    def __init__(self) -> None:
        self.status: int | None = None
        self.headers: dict[str, str] = {}
        self.wfile = io.BytesIO()
        self.close_connection = False

    def send_response(self, status: int) -> None:
        self.status = status

    def send_header(self, name: str, value: str) -> None:
        self.headers[name.lower()] = value

    def end_headers(self) -> None:
        return None


def test_error_response_includes_code_when_provided() -> None:
    body = server_module.error_response(RuntimeError("boom"), code="rate_limited")

    assert body["status"] == "error"
    assert body["code"] == "rate_limited"
    assert body["message"] == "boom"


def test_error_response_omits_code_by_default() -> None:
    body = server_module.error_response(RuntimeError("boom"))

    assert "code" not in body


@pytest.mark.parametrize(
    ("exc", "code"),
    [
        (
            ContentPolicyViolationError([("question.question", "HTMLタグを含む")]),
            "content_invalid",
        ),
        (ResearchIncompleteError("incomplete"), "research_incomplete"),
        (ResearchFailedError("failed"), "research_failed"),
    ],
)
def test_error_response_uses_exception_error_code(exc: Exception, code: str) -> None:
    body = server_module.error_response(exc)

    assert body["code"] == code


def test_quota_exhausted_response_sets_rate_limited_code() -> None:
    exc = QuotaExhaustedError("OpenRouterのレート制限/日次リクエスト上限に達しました")

    body = server_module.quota_exhausted_response(exc)

    assert body["status"] == "error"
    assert body["code"] == "rate_limited"
    assert body["message"] == str(exc)


def test_server_do_post_returns_429_with_rate_limited_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def raise_quota(*args: Any, **kwargs: Any) -> None:
        raise QuotaExhaustedError("上限に達しました")

    monkeypatch.setattr(server_module, "_parse_body", lambda handler: {})
    monkeypatch.setattr(server_module, "build_generate_response", raise_quota)

    handler = _FakeHandler()
    server_module.Handler.do_POST(handler)

    assert handler.sent is not None
    status, body = handler.sent
    assert status == HTTPStatus.TOO_MANY_REQUESTS
    assert body["code"] == "rate_limited"


@pytest.mark.parametrize(
    ("exc", "expected_status", "expected_code"),
    [
        (
            ResearchIncompleteError("調査が不完全です"),
            HTTPStatus.UNPROCESSABLE_ENTITY,
            "research_incomplete",
        ),
        (
            ResearchFailedError("調査依存が失敗しました"),
            HTTPStatus.BAD_GATEWAY,
            "research_failed",
        ),
    ],
)
def test_server_do_post_maps_research_errors(
    monkeypatch: pytest.MonkeyPatch,
    exc: Exception,
    expected_status: HTTPStatus,
    expected_code: str,
) -> None:
    def raise_research_error(*args: Any, **kwargs: Any) -> None:
        raise exc

    monkeypatch.setattr(server_module, "_parse_body", lambda handler: {})
    monkeypatch.setattr(server_module, "build_generate_response", raise_research_error)

    handler = _FakeHandler()
    server_module.Handler.do_POST(handler)

    assert handler.sent is not None
    status, body = handler.sent
    assert status == expected_status
    assert body["code"] == expected_code


def test_server_do_post_returns_422_for_content_violation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    error = ContentPolicyViolationError(
        [("explanation.correct_reason", "Markdown強調を含む")]
    )

    def raise_content_error(*args: Any, **kwargs: Any) -> None:
        raise error

    monkeypatch.setattr(server_module, "_parse_body", lambda handler: {})
    monkeypatch.setattr(server_module, "build_generate_response", raise_content_error)

    handler = _FakeHandler()
    server_module.Handler.do_POST(handler)

    assert handler.sent is not None
    status, body = handler.sent
    assert status == HTTPStatus.UNPROCESSABLE_ENTITY
    assert body["code"] == "content_invalid"


def test_generate_response_excludes_internal_grounding_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    item = server_module._stub_quiz("aip", None)
    monkeypatch.setattr(
        server_module,
        "_generate_quiz",
        lambda cert, domain, on_phase=None: (item, GateResult(status="not_run")),
    )

    response = server_module.build_generate_response({}, started=0.0)

    assert "grounding_claim_en" not in response["quiz"]["explanation"]
    assert response["quiz"]["explanation"]["correct_reason"]


def test_runtime_do_post_returns_http_200_with_rate_limited_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def raise_quota(*args: Any, **kwargs: Any) -> None:
        raise QuotaExhaustedError("上限に達しました")

    monkeypatch.setattr(runtime_module, "_parse_body", lambda handler: {})
    monkeypatch.setattr(runtime_module, "build_generate_response", raise_quota)

    handler = _FakeHandler()
    handler.path = "/invocations"
    runtime_module.RuntimeHandler.do_POST(handler)

    assert handler.sent is not None
    status, body = handler.sent
    # AgentCore は非200を例外扱いするため、エラーもHTTP 200で返す
    assert status == HTTPStatus.OK
    assert body["code"] == "rate_limited"


def test_sse_data_builds_single_data_frame() -> None:
    frame = runtime_module._sse_data(
        {"type": "phase", "phase": "research", "attempt": 1, "totalAttempts": 3}
    )

    assert frame.startswith(b"data: ")
    assert frame.endswith(b"\n\n")
    assert json.loads(frame.removeprefix(b"data: ").strip()) == {
        "type": "phase",
        "phase": "research",
        "attempt": 1,
        "totalAttempts": 3,
    }


def test_runtime_stream_true_returns_phase_and_result_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def build_response(
        body: dict[str, Any], *, on_phase: Any, **kwargs: Any
    ) -> dict[str, Any]:
        on_phase("generation", {"attempt": 1, "totalAttempts": 1})
        return {"status": "ok", "quiz": {"question": "generated"}}

    monkeypatch.setattr(runtime_module, "_parse_body", lambda handler: {"stream": True})
    monkeypatch.setattr(runtime_module, "build_generate_response", build_response)
    handler = _StreamFakeHandler()

    runtime_module.RuntimeHandler.do_POST(handler)

    assert handler.status == HTTPStatus.OK
    assert handler.headers["content-type"].startswith("text/event-stream")
    assert handler.headers["cache-control"] == "no-cache"
    assert handler.close_connection is True
    frames = [
        json.loads(line.removeprefix("data: "))
        for line in handler.wfile.getvalue().decode().splitlines()
        if line.startswith("data: ")
    ]
    assert frames == [
        {
            "type": "phase",
            "phase": "generation",
            "attempt": 1,
            "totalAttempts": 1,
        },
        {
            "type": "result",
            "status": "ok",
            "quiz": {"question": "generated"},
        },
    ]


def test_runtime_without_stream_flag_keeps_json_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_module, "_parse_body", lambda handler: {})
    monkeypatch.setattr(
        runtime_module,
        "build_generate_response",
        lambda *args, **kwargs: {"status": "ok", "quiz": {}},
    )
    handler = _FakeHandler()
    handler.path = "/invocations"

    runtime_module.RuntimeHandler.do_POST(handler)

    assert handler.sent == (HTTPStatus.OK, {"status": "ok", "quiz": {}})


def test_runtime_stream_error_stays_http_200_and_ends_with_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_module, "_parse_body", lambda handler: {"stream": True})
    monkeypatch.setattr(
        runtime_module,
        "build_generate_response",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("生成失敗")),
    )
    handler = _StreamFakeHandler()

    runtime_module.RuntimeHandler.do_POST(handler)

    frames = [
        json.loads(line.removeprefix("data: "))
        for line in handler.wfile.getvalue().decode().splitlines()
        if line.startswith("data: ")
    ]
    assert handler.status == HTTPStatus.OK
    assert frames[-1]["type"] == "result"
    assert frames[-1]["status"] == "error"
    assert frames[-1]["message"] == "生成失敗"


def test_runtime_do_post_ping_returns_ok_without_generating(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """デプロイ後スモーク用の疎通。生成もモデル呼び出しも起こさない(issue #103)。"""

    def fail(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("ping で生成を呼んではいけない")

    monkeypatch.setattr(
        runtime_module, "_parse_body", lambda handler: {"action": "ping"}
    )
    monkeypatch.setattr(runtime_module, "build_generate_response", fail)

    handler = _FakeHandler()
    handler.path = "/invocations"
    runtime_module.RuntimeHandler.do_POST(handler)

    assert handler.sent is not None
    status, body = handler.sent
    assert status == HTTPStatus.OK
    assert body["status"] == "ok"
    assert body["action"] == "ping"
    assert body["agent_version"] == runtime_module.AGENT_VERSION


def test_runtime_do_post_without_ping_action_still_generates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ping判定が広すぎて通常の生成要求まで空応答にしないこと。"""
    calls: list[dict[str, Any]] = []

    def record(body: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        calls.append(body)
        return {"status": "ok", "quiz": {}}

    monkeypatch.setattr(
        runtime_module,
        "_parse_body",
        lambda handler: {"cert": "aip", "action": "generate"},
    )
    monkeypatch.setattr(runtime_module, "build_generate_response", record)

    handler = _FakeHandler()
    handler.path = "/invocations"
    runtime_module.RuntimeHandler.do_POST(handler)

    assert len(calls) == 1
