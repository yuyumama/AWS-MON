"""ローカルHTTPサーバ。

API層から問題生成エージェントを呼ぶための最小HTTP境界。
本番ではこの境界をAgentCore Runtime呼び出しに差し替える想定。
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from contextlib import contextmanager
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterator

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:

    def load_dotenv() -> bool:
        return False


from .content_policy import ContentPolicyViolationError
from .judge import JudgeResult
from .log_filters import suppress_duplicate_strands_warnings
from .model_config import model_id as _model_id
from .quality_checks import split_source_urls
from .schema import Explanation, Option, OptionReason, Question, QuizItem

AGENT_VERSION = "local-http-v1"
PROMPT_VERSION = "quiz-v1"


def _stub_quiz(cert: str, domain: str | None) -> QuizItem:
    domain_label = domain or "general"
    nonce = int(time.time() * 1000)
    return QuizItem(
        summary="Bedrock Knowledge BasesによるRAG構成",
        question=Question(
            type="single",
            question=(
                f"[stub:{nonce}] {cert}/{domain_label}: Amazon Bedrock Knowledge Bases の主な用途として"
                "最も適切なものはどれですか。"
            ),
            options=[
                Option(label="A", text="基盤モデルをゼロから事前学習する"),
                Option(label="B", text="外部データを検索し、RAGで回答生成に利用する"),
                Option(label="C", text="CloudWatch Logs の保持期間を変更する"),
                Option(label="D", text="VPC のCIDRブロックを自動拡張する"),
            ],
            correct=["B"],
        ),
        explanation=Explanation(
            overview="Knowledge Bases は外部データを検索して生成時の根拠として使うRAG構成を支援します。",
            correct_reason="選択肢BがKnowledge Basesの用途に該当します。",
            option_reasons=[
                OptionReason(
                    label="A",
                    reason="Knowledge Basesは事前学習の仕組みではありません。",
                ),
                OptionReason(
                    label="B", reason="外部データ検索とRAGでの利用に該当します。"
                ),
                OptionReason(
                    label="C",
                    reason="CloudWatch Logsの設定であり、Knowledge Basesとは無関係です。",
                ),
                OptionReason(
                    label="D",
                    reason="VPC設計の話であり、Knowledge Basesとは無関係です。",
                ),
            ],
            source="https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html",
        ),
    )


def _generate_quiz(
    cert: str,
    domain: str | None,
    domain_label: str | None = None,
    domain_label_en: str | None = None,
    *,
    on_phase: Callable[[str, dict[str, int]], None] | None = None,
) -> tuple[QuizItem, JudgeResult]:
    if os.environ.get("AGENT_STUB") == "1":
        if on_phase is not None:
            on_phase("generation", {"attempt": 1, "totalAttempts": 1})
            # 実経路と同じ工程をローカルでも辿れるようにする(#155)
            on_phase("validation", {"attempt": 1, "totalAttempts": 1})
        return _stub_quiz(cert, domain), JudgeResult(status="not_run", detail="stub")

    from .agent import generate_quiz

    result = generate_quiz(
        cert=cert,
        domain=domain,
        domain_label=domain_label,
        domain_label_en=domain_label_en,
        on_phase=on_phase,
    )
    return result.item, result.judge


def _quality(judge: JudgeResult, evaluated_at: str) -> dict[str, Any]:
    # inlineGate / evaluator / score / issues は後方互換のために残すフィールドである。
    # オンライン評価は ADR 0011 で、Guardrails グラウンディングゲートは ADR 0018 で
    # それぞれ廃止したため、新規保存の値は常に not_run / none で score は付かない。
    # 既存の DynamoDB アイテムに passed / failed / self_review / agentcore_evaluate と
    # スコアが残っているため、フィールド自体は維持する。
    quality: dict[str, Any] = {
        "inlineGate": "not_run",
        "evaluator": "none",
    }
    if judge.status not in ("not_run", "error"):
        quality["evaluatedAt"] = evaluated_at

    # 自己整合ジャッジ(#140)。判定できなかった場合はフィールドごと出さず、
    # ジャッジ導入前に保存されたアイテムと同じ形にする。
    if judge.status not in ("not_run", "error"):
        judge_payload: dict[str, Any] = {
            "status": judge.status,
            "modelId": judge.model_id,
            "defectTypes": [defect.type for defect in judge.defects],
        }
        if judge.detail:
            judge_payload["detail"] = judge.detail
        quality["judge"] = judge_payload
    return quality


@contextmanager
def _otel_session(session_id: str | None) -> Iterator[None]:
    """出題セッションIDをOTel baggageの session.id に載せる(フェーズ3-1)。

    CloudWatch生成AIオブザーバビリティはbaggageの session.id でトレースを
    セッション単位に束ねる。OTel未計装(通常起動)なら何もしない。
    """
    if not session_id:
        yield
        return
    try:
        from opentelemetry import baggage, context
    except ImportError:
        yield
        return
    token = context.attach(baggage.set_baggage("session.id", session_id))
    try:
        yield
    finally:
        context.detach(token)


def _now_iso() -> str:
    return (
        time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        + f".{int((time.time() % 1) * 1000):03d}Z"
    )


def _as_json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def _parse_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("content-length") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    body = json.loads(raw.decode("utf-8"))
    if not isinstance(body, dict):
        raise ValueError("request body must be a JSON object")
    return body


def _str_value(value: Any, fallback: str | None = None) -> str | None:
    return value if isinstance(value, str) and value else fallback


def build_generate_response(
    body: dict[str, Any],
    *,
    started: float,
    agent_version: str = AGENT_VERSION,
    on_phase: Callable[[str, dict[str, int]], None] | None = None,
) -> dict[str, Any]:
    cert = _str_value(body.get("cert"), "aip")
    domain = _str_value(body.get("domain"))
    domain_selection = _str_value(body.get("domainSelection"), domain)
    domain_label = _str_value(body.get("domainLabel"))
    domain_label_en = _str_value(body.get("domainLabelEn"))
    session_id = _str_value(body.get("sessionId"))
    with _otel_session(session_id):
        generate_kwargs: dict[str, Any] = {
            "cert": cert or "aip",
            "domain": domain,
            "on_phase": on_phase,
        }
        if domain_label is not None or domain_label_en is not None:
            generate_kwargs.update(
                domain_label=domain_label, domain_label_en=domain_label_en
            )
        item, judge = _generate_quiz(**generate_kwargs)
    generated_at = _now_iso()
    latency_ms = int((time.perf_counter() - started) * 1000)
    source = item.explanation.source

    return {
        "status": "ok",
        "cert": cert,
        "domain": domain,
        "domainSelection": domain_selection,
        "quiz": item.model_dump(),
        "generation": {
            "modelId": _model_id(),
            "promptVersion": PROMPT_VERSION,
            "agentVersion": agent_version,
            "generatedAt": generated_at,
            "latencyMs": latency_ms,
        },
        "quality": _quality(judge, generated_at),
        "sourceRefs": _source_refs(source, generated_at),
    }


def _source_refs(source: str, retrieved_at: str) -> list[dict[str, str]]:
    """explanation.source を 1URL = 1要素の sourceRefs に展開する。

    モデルは複数URLをカンマ/セミコロンで連結して返すことがあり、prod には
    連結された値が sourceRefs[0].url に入ったアイテムが3件ある(#139)。
    URLが1つも取れない値は、参照元の情報を落とさないため従来どおりそのまま残す。
    """
    urls = split_source_urls(source) or [source]
    return [{"url": url, "retrievedAt": retrieved_at} for url in urls]


def error_response(
    exc: Exception, *, agent_version: str = AGENT_VERSION, code: str | None = None
) -> dict[str, Any]:
    body: dict[str, Any] = {"status": "error"}
    if code is None:
        exception_code = getattr(exc, "error_code", None)
        code = exception_code if isinstance(exception_code, str) else None
    if code:
        body["code"] = code
    body["message"] = str(exc)
    body["modelId"] = _model_id()
    body["agentVersion"] = agent_version
    return body


def quota_exhausted_response(
    exc: Exception, *, agent_version: str = AGENT_VERSION
) -> dict[str, Any]:
    """OpenRouterの429(レート制限/日次枠切れ)応答ボディ。"""
    return error_response(exc, agent_version=agent_version, code="rate_limited")


class Handler(BaseHTTPRequestHandler):
    server_version = "aws-mon-agent/0.1"

    def _send_json(self, status: int, body: object) -> None:
        payload = _as_json_bytes(body)
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/health":
            self._send_json(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "service": "agent",
                    "modelId": _model_id(),
                    "stub": os.environ.get("AGENT_STUB") == "1",
                    "agentVersion": AGENT_VERSION,
                    "time": _now_iso(),
                },
            )
            return
        self._send_json(
            HTTPStatus.NOT_FOUND, {"status": "error", "message": "not found"}
        )

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path != "/generate":
            self._send_json(
                HTTPStatus.NOT_FOUND, {"status": "error", "message": "not found"}
            )
            return

        started = time.perf_counter()
        try:
            body = _parse_body(self)
            self._send_json(
                HTTPStatus.OK, build_generate_response(body, started=started)
            )
        except ContentPolicyViolationError as exc:
            # 日本語プレーンテキスト要件・決定的品質チェックを満たさない問題は保存させない。
            self._send_json(HTTPStatus.UNPROCESSABLE_ENTITY, error_response(exc))
        except Exception as exc:  # noqa: BLE001 - HTTP boundary returns JSON error
            # .agent は重い依存(strands/mcp)を持つため、エラー時のみ遅延importする
            from .agent import (
                QuotaExhaustedError,
                ResearchFailedError,
                ResearchIncompleteError,
            )

            if isinstance(exc, QuotaExhaustedError):
                self._send_json(
                    HTTPStatus.TOO_MANY_REQUESTS, quota_exhausted_response(exc)
                )
                return
            if isinstance(exc, ResearchIncompleteError):
                self._send_json(HTTPStatus.UNPROCESSABLE_ENTITY, error_response(exc))
                return
            if isinstance(exc, ResearchFailedError):
                self._send_json(HTTPStatus.BAD_GATEWAY, error_response(exc))
                return
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, error_response(exc))


def main() -> int:
    load_dotenv()
    suppress_duplicate_strands_warnings()
    host = os.environ.get("AGENT_HOST", "127.0.0.1")
    port = int(os.environ.get("AGENT_PORT", "8090"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"agent listening on http://{host}:{port}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
