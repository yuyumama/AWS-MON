from __future__ import annotations

import sys
from types import SimpleNamespace
from typing import Any

import pytest

from quiz_agent import guardrail

# check_grounding は「生成した問題を通すか弾くか」を決めるゲートの判定そのものである。
# ここが誤ると全問素通りにも全問ブロックにも倒れうるが、既存テストは GateResult 型を
# import しているだけで関数本体を一度も呼んでいなかった。
#
# boto3 は sys.modules を差し替えて置換し、AWS認証情報に依存しない
# (test_agent.py と同じ手法)。


class FakeBedrockRuntime:
    """apply_guardrail の呼び出しを記録し、指定のレスポンスを返す。"""

    def __init__(self, response: dict[str, Any] | Exception) -> None:
        self._response = response
        self.calls: list[dict[str, Any]] = []

    def apply_guardrail(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


def install_boto3(
    monkeypatch: pytest.MonkeyPatch, response: dict[str, Any] | Exception
) -> tuple[FakeBedrockRuntime, list[tuple[str, dict[str, Any]]]]:
    client = FakeBedrockRuntime(response)
    client_calls: list[tuple[str, dict[str, Any]]] = []

    def factory(service_name: str, **kwargs: Any) -> FakeBedrockRuntime:
        client_calls.append((service_name, kwargs))
        return client

    monkeypatch.setitem(sys.modules, "boto3", SimpleNamespace(client=factory))
    return client, client_calls


def grounding_response(
    *,
    grounding: float | None = 0.82,
    relevance: float | None = 0.71,
    action: str | None = None,
    filter_action: str | None = None,
) -> dict[str, Any]:
    filters: list[dict[str, Any]] = []
    if grounding is not None:
        entry: dict[str, Any] = {"type": "GROUNDING", "score": grounding}
        if filter_action:
            entry["action"] = filter_action
        filters.append(entry)
    if relevance is not None:
        filters.append({"type": "RELEVANCE", "score": relevance})

    response: dict[str, Any] = {
        "assessments": [{"contextualGroundingPolicy": {"filters": filters}}]
    }
    if action:
        response["action"] = action
    return response


@pytest.fixture(autouse=True)
def _guardrail_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "AGENT_GUARDRAIL_ID",
        "AGENT_GUARDRAIL_VERSION",
        "AGENT_GUARDRAIL_ENFORCE",
        "AGENT_GUARDRAIL_RETRIES",
        "AWS_REGION",
    ):
        monkeypatch.delenv(key, raising=False)


class TestGateSettings:
    def test_gate_enabled_follows_guardrail_id(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        assert guardrail.gate_enabled() is False
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-1")
        assert guardrail.gate_enabled() is True

    def test_gate_enabled_treats_empty_string_as_disabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "")
        assert guardrail.gate_enabled() is False

    def test_gate_enforced_defaults_to_blocking(self) -> None:
        # 既定は「弾く」。ここが既定でレポートのみに倒れると、全問素通りになる。
        assert guardrail.gate_enforced() is True

    @pytest.mark.parametrize("value", ["0", "false", "FALSE", "off", "Off"])
    def test_gate_enforced_can_be_turned_off(
        self, monkeypatch: pytest.MonkeyPatch, value: str
    ) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ENFORCE", value)
        assert guardrail.gate_enforced() is False

    @pytest.mark.parametrize("value", ["1", "true", "yes", "on", "no"])
    def test_gate_enforced_keeps_blocking_for_other_values(
        self, monkeypatch: pytest.MonkeyPatch, value: str
    ) -> None:
        # 「0/false/off 以外はすべて有効」という現行の契約を固定する。
        monkeypatch.setenv("AGENT_GUARDRAIL_ENFORCE", value)
        assert guardrail.gate_enforced() is True

    def test_gate_retries_defaults_to_one(self) -> None:
        assert guardrail.gate_retries() == 1

    @pytest.mark.parametrize(("value", "expected"), [("0", 0), ("3", 3)])
    def test_gate_retries_reads_env(
        self, monkeypatch: pytest.MonkeyPatch, value: str, expected: int
    ) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_RETRIES", value)
        assert guardrail.gate_retries() == expected


class TestNotConfigured:
    def test_returns_not_run_without_guardrail_id(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, _ = install_boto3(monkeypatch, grounding_response())

        result = guardrail.check_grounding("source", "query", "content")

        assert result.status == "not_run"
        assert result.detail == "guardrail not configured"
        assert result.grounding_score is None
        assert result.relevance_score is None
        # 未設定のときは呼び出しにも行かないこと(無駄な課金・レイテンシを避ける)
        assert client.calls == []


class TestRequestShape:
    def test_passes_qualifiers_and_guardrail_settings(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        monkeypatch.setenv("AGENT_GUARDRAIL_VERSION", "3")
        monkeypatch.setenv("AWS_REGION", "ap-northeast-1")
        client, client_calls = install_boto3(monkeypatch, grounding_response())

        guardrail.check_grounding("the source", "the query", "the content")

        assert client_calls == [("bedrock-runtime", {"region_name": "ap-northeast-1"})]
        call = client.calls[0]
        assert call["guardrailIdentifier"] == "gr-abc"
        assert call["guardrailVersion"] == "3"
        assert call["source"] == "OUTPUT"
        assert [c["text"]["qualifiers"] for c in call["content"]] == [
            ["grounding_source"],
            ["query"],
            ["guard_content"],
        ]
        assert [c["text"]["text"] for c in call["content"]] == [
            "the source",
            "the query",
            "the content",
        ]

    def test_uses_default_version_and_region(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        client, client_calls = install_boto3(monkeypatch, grounding_response())

        guardrail.check_grounding("s", "q", "c")

        assert client_calls == [("bedrock-runtime", {"region_name": "us-east-1"})]
        assert client.calls[0]["guardrailVersion"] == "DRAFT"

    def test_truncates_each_field_to_its_own_limit(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # 上限超過はAPIエラーになる。切り詰めが外れると全件 not_run に倒れる。
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        client, _ = install_boto3(monkeypatch, grounding_response())

        guardrail.check_grounding(
            "a" * (guardrail.MAX_GROUNDING_SOURCE_CHARS + 500),
            "b" * (guardrail.MAX_QUERY_CHARS + 500),
            "c" * (guardrail.MAX_GUARD_CONTENT_CHARS + 500),
        )

        lengths = [len(c["text"]["text"]) for c in client.calls[0]["content"]]
        assert lengths == [
            guardrail.MAX_GROUNDING_SOURCE_CHARS,
            guardrail.MAX_QUERY_CHARS,
            guardrail.MAX_GUARD_CONTENT_CHARS,
        ]

    def test_keeps_short_input_untouched(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        client, _ = install_boto3(monkeypatch, grounding_response())

        guardrail.check_grounding("short", "q", "c")

        assert client.calls[0]["content"][0]["text"]["text"] == "short"


class TestVerdict:
    def test_passes_and_extracts_both_scores(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        install_boto3(monkeypatch, grounding_response(grounding=0.82, relevance=0.71))

        result = guardrail.check_grounding("s", "q", "c")

        assert result.status == "passed"
        assert result.grounding_score == 0.82
        assert result.relevance_score == 0.71
        assert result.detail is None

    def test_fails_when_a_filter_is_blocked(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        install_boto3(
            monkeypatch,
            grounding_response(grounding=0.31, filter_action="BLOCKED"),
        )

        result = guardrail.check_grounding("s", "q", "c")

        assert result.status == "failed"
        assert result.grounding_score == 0.31
        assert result.detail is not None
        assert "grounding=0.31" in result.detail

    def test_fails_when_guardrail_intervened_without_blocked_filter(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # BLOCKED が付かなくても介入したなら弾く。
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        install_boto3(
            monkeypatch,
            grounding_response(action="GUARDRAIL_INTERVENED"),
        )

        result = guardrail.check_grounding("s", "q", "c")

        assert result.status == "failed"

    def test_passes_when_action_is_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        install_boto3(monkeypatch, grounding_response(action="NONE"))

        result = guardrail.check_grounding("s", "q", "c")

        assert result.status == "passed"

    def test_reads_scores_across_multiple_assessments(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        install_boto3(
            monkeypatch,
            {
                "assessments": [
                    {
                        "contextualGroundingPolicy": {
                            "filters": [{"type": "GROUNDING", "score": 0.5}]
                        }
                    },
                    {
                        "contextualGroundingPolicy": {
                            "filters": [{"type": "RELEVANCE", "score": 0.9}]
                        }
                    },
                ]
            },
        )

        result = guardrail.check_grounding("s", "q", "c")

        assert result.grounding_score == 0.5
        assert result.relevance_score == 0.9
        assert result.status == "passed"

    def test_ignores_unknown_filter_types(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        install_boto3(
            monkeypatch,
            {
                "assessments": [
                    {
                        "contextualGroundingPolicy": {
                            "filters": [{"type": "SOMETHING_NEW", "score": 0.1}]
                        }
                    }
                ]
            },
        )

        result = guardrail.check_grounding("s", "q", "c")

        assert result.status == "passed"
        assert result.grounding_score is None
        assert result.relevance_score is None

    def test_blocks_even_when_the_blocked_filter_has_no_score(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        install_boto3(
            monkeypatch,
            {
                "assessments": [
                    {
                        "contextualGroundingPolicy": {
                            "filters": [{"type": "GROUNDING", "action": "BLOCKED"}]
                        }
                    }
                ]
            },
        )

        result = guardrail.check_grounding("s", "q", "c")

        assert result.status == "failed"


class TestMalformedResponses:
    # レスポンス形状が想定外でも例外を投げないこと。ここで落ちると
    # 生成全体が落ちる(fail-open の意図が壊れる)。
    @pytest.mark.parametrize(
        "response",
        [
            pytest.param({}, id="空のレスポンス"),
            pytest.param({"assessments": []}, id="assessmentsが空配列"),
            pytest.param({"assessments": None}, id="assessmentsがNone"),
            pytest.param({"assessments": [{}]}, id="ポリシーのキーが無い"),
            pytest.param(
                {"assessments": [{"contextualGroundingPolicy": None}]},
                id="ポリシーがNone",
            ),
            pytest.param(
                {"assessments": [{"contextualGroundingPolicy": {}}]},
                id="filtersのキーが無い",
            ),
            pytest.param(
                {"assessments": [{"contextualGroundingPolicy": {"filters": None}}]},
                id="filtersがNone",
            ),
            pytest.param(
                {"assessments": [{"contextualGroundingPolicy": {"filters": [{}]}}]},
                id="filterが空辞書",
            ),
        ],
    )
    def test_returns_passed_without_raising(
        self, monkeypatch: pytest.MonkeyPatch, response: dict[str, Any]
    ) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        install_boto3(monkeypatch, response)

        result = guardrail.check_grounding("s", "q", "c")

        assert result.status == "passed"
        assert result.grounding_score is None
        assert result.relevance_score is None


class TestFailOpen:
    # ADR 0017 / issue #79 のとおり、fail-open は ApplyGuardrail の障害に限る。
    def test_api_error_returns_not_run(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        install_boto3(monkeypatch, RuntimeError("AccessDeniedException"))

        result = guardrail.check_grounding("s", "q", "c")

        assert result.status == "not_run"
        assert result.detail is not None
        assert "apply_guardrail error" in result.detail
        assert "AccessDeniedException" in result.detail

    def test_missing_boto3_returns_not_run(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")
        monkeypatch.setitem(sys.modules, "boto3", None)

        result = guardrail.check_grounding("s", "q", "c")

        assert result.status == "not_run"

    def test_client_construction_failure_returns_not_run(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AGENT_GUARDRAIL_ID", "gr-abc")

        def factory(service_name: str, **kwargs: Any) -> Any:
            raise RuntimeError("no region")

        monkeypatch.setitem(sys.modules, "boto3", SimpleNamespace(client=factory))

        result = guardrail.check_grounding("s", "q", "c")

        assert result.status == "not_run"
        assert result.detail is not None
        assert "no region" in result.detail
