from __future__ import annotations

import json
import logging
import sys
from contextlib import contextmanager
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from openai import APIError

from quiz_agent import agent as agent_module
from quiz_agent.guardrail import GateResult
from quiz_agent.model_config import model_id, openrouter_api_key
from quiz_agent.schema import QuizItem


def _quiz_item(question: str = "設問はどれか。") -> QuizItem:
    return QuizItem.model_validate(
        {
            "summary": "Bedrock Knowledge Basesの検索設計",
            "question": {
                "type": "single",
                "question": question,
                "options": [
                    {"label": "A", "text": "正解"},
                    {"label": "B", "text": "不正解"},
                    {"label": "C", "text": "不正解"},
                    {"label": "D", "text": "不正解"},
                ],
                "correct": ["A"],
            },
            "explanation": {
                "overview": "概要",
                "correct_reason": "正解の理由",
                "grounding_claim_en": (
                    "The correct option accurately reflects the documented AWS service "
                    "behavior. It applies the capability described in the source."
                ),
                "option_reasons": [
                    {"label": label, "reason": "理由"} for label in ("A", "B", "C", "D")
                ],
                "source": "https://docs.aws.amazon.com/example",
            },
        }
    )


class FakeMCPClient:
    def __init__(self) -> None:
        self.enter_count = 0
        self.list_tools_count = 0

    def __enter__(self) -> FakeMCPClient:
        self.enter_count += 1
        return self

    def __exit__(self, *args: Any) -> None:
        return None

    def list_tools_sync(self) -> list[Any]:
        self.list_tools_count += 1
        return []


class FakeAgent:
    structured_results: list[QuizItem | Exception] = []
    instances: list[FakeAgent] = []
    research_messages: list[Any] | None = None

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.research_count = 0
        self.structured_count = 0
        self.structured_prompts: list[str] = []
        self.messages: list[Any] = []
        self.instances.append(self)

    def __call__(self, prompt: str) -> None:
        self.research_count += 1
        self.messages = self.research_messages or [
            {
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": "read-1",
                            "name": "read_documentation",
                            "input": {},
                        }
                    }
                ]
            },
            {
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "read-1",
                            "status": "success",
                            "content": [{"text": "調査済みAWSドキュメント原文"}],
                        }
                    }
                ]
            },
        ]

    def structured_output(self, output_model: type[QuizItem], prompt: str) -> QuizItem:
        self.structured_count += 1
        self.structured_prompts.append(prompt)
        result = self.structured_results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture(autouse=True)
def _reset_fake_agent() -> None:
    FakeAgent.structured_results = []
    FakeAgent.instances = []
    FakeAgent.research_messages = None


def _mock_research(monkeypatch: pytest.MonkeyPatch) -> FakeMCPClient:
    client = FakeMCPClient()
    monkeypatch.setattr(agent_module, "Agent", FakeAgent)
    monkeypatch.setattr(agent_module, "_docs_mcp_client", lambda: client)
    monkeypatch.setattr(agent_module, "_model", lambda: object())
    return client


def test_gate_retry_reuses_research_and_only_repeats_structured_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _mock_research(monkeypatch)
    FakeAgent.structured_results = [
        _quiz_item("初回はどれか。"),
        _quiz_item("再生成はどれか。"),
    ]
    gates = iter(
        [
            GateResult(status="failed", detail="grounding=0.1"),
            GateResult(status="passed"),
        ]
    )
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: True)
    monkeypatch.setattr(agent_module, "gate_retries", lambda: 1)
    monkeypatch.setattr(agent_module, "check_grounding", lambda **kwargs: next(gates))

    result = agent_module._generate_quiz_with_docs_and_gate("問題生成プロンプト")

    assert result.item.question.question == "再生成はどれか。"
    assert result.gate.status == "passed"
    assert client.enter_count == 1
    assert client.list_tools_count == 1
    assert len(FakeAgent.instances) == 1
    assert FakeAgent.instances[0].research_count == 1
    assert FakeAgent.instances[0].structured_count == 2


def test_structured_output_retry_keeps_research_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _mock_research(monkeypatch)
    FakeAgent.structured_results = [ValueError("invalid output"), _quiz_item()]
    monkeypatch.setattr(agent_module.time, "sleep", lambda seconds: None)

    item, source_texts = agent_module._generate_quiz_with_docs("問題生成プロンプト")

    assert item.question.question == "設問はどれか。"
    assert source_texts == ["調査済みAWSドキュメント原文"]
    assert client.enter_count == 1
    assert len(FakeAgent.instances) == 1
    assert FakeAgent.instances[0].research_count == 1
    assert FakeAgent.instances[0].structured_count == 2


def test_structured_output_failure_does_not_fall_back_without_research(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_structured_output(prompt: str, cert: str | None = None) -> None:
        raise RuntimeError("structured output failed")

    monkeypatch.setattr(agent_module, "_docs_mcp_enabled", lambda: True)
    monkeypatch.setattr(
        agent_module,
        "_generate_quiz_with_docs_and_gate",
        fail_structured_output,
    )
    monkeypatch.setattr(
        agent_module,
        "_generate",
        lambda *args, **kwargs: pytest.fail("調査なし生成へフォールバックしないこと"),
    )

    with pytest.raises(RuntimeError, match="structured output failed"):
        agent_module.generate_quiz("saa")


def test_model_id_defaults_to_openrouter_free_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AGENT_MODEL_ID", raising=False)

    # ADR 0016 で ling-3.0-flash に切り替えたが、2026-08-08 に OpenRouter が
    # 無料枠を廃止したため nemotron-3-ultra へ切り戻した
    assert model_id() == "nvidia/nemotron-3-ultra-550b-a55b:free"


def test_openrouter_api_key_prefers_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "env-key")
    monkeypatch.setenv("OPENROUTER_API_KEY_PARAM", "/ignored")
    monkeypatch.setitem(
        sys.modules,
        "boto3",
        SimpleNamespace(
            client=lambda *args, **kwargs: pytest.fail("SSMを呼ばないこと")
        ),
    )

    assert openrouter_api_key() == "env-key"


def test_openrouter_api_key_falls_back_to_ssm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: dict[str, Any] = {}

    class FakeSSM:
        def get_parameter(self, **kwargs: Any) -> dict[str, Any]:
            calls["get_parameter"] = kwargs
            return {"Parameter": {"Value": "ssm-key"}}

    def client(service_name: str, **kwargs: Any) -> FakeSSM:
        calls["client"] = (service_name, kwargs)
        return FakeSSM()

    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv(
        "OPENROUTER_API_KEY_PARAM", "/app/aws-mon/prod/openrouter-api-key"
    )
    monkeypatch.setenv("AWS_REGION", "ap-northeast-1")
    monkeypatch.setitem(sys.modules, "boto3", SimpleNamespace(client=client))

    assert openrouter_api_key() == "ssm-key"
    assert calls["client"] == ("ssm", {"region_name": "ap-northeast-1"})
    assert calls["get_parameter"] == {
        "Name": "/app/aws-mon/prod/openrouter-api-key",
        "WithDecryption": True,
    }


def test_openrouter_api_key_requires_env_or_parameter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY_PARAM", raising=False)

    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY_PARAM"):
        openrouter_api_key()


class _FakeRateLimitError(Exception):
    """openai.RateLimitError相当(status_code=429)のダミー例外。"""

    def __init__(self, message: str = "rate limited") -> None:
        super().__init__(message)
        self.status_code = 429


class _RateLimitedResearchAgent(FakeAgent):
    def __call__(self, prompt: str) -> None:
        raise _FakeRateLimitError("OpenRouter 429 during research")


def _transient_api_error() -> APIError:
    return APIError(
        "Upstream error from Nvidia: ResourceExhausted",
        request=httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions"),
        body=None,
    )


def test_is_rate_limit_detects_status_code_429() -> None:
    assert agent_module._is_rate_limit(_FakeRateLimitError()) is True


def test_is_rate_limit_detects_wrapped_exception_via_cause() -> None:
    original = _FakeRateLimitError()
    try:
        raise RuntimeError("wrapped") from original
    except RuntimeError as wrapped:
        assert agent_module._is_rate_limit(wrapped) is True


def test_is_rate_limit_false_for_unrelated_exception() -> None:
    assert agent_module._is_rate_limit(ValueError("invalid output")) is False


def test_is_transient_model_error_detects_wrapped_statusless_api_error() -> None:
    try:
        raise RuntimeError("event loop failed") from _transient_api_error()
    except RuntimeError as wrapped:
        assert agent_module._is_transient_model_error(wrapped) is True


def test_research_transient_model_error_retries_with_fresh_agents(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _mock_research(monkeypatch)
    monkeypatch.setenv("AGENT_RESEARCH_RETRIES", "2")
    monkeypatch.setattr(agent_module.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(agent_module.random, "uniform", lambda start, end: 0.0)

    class _TransientThenSuccessfulAgent(FakeAgent):
        research_calls = 0

        def __call__(self, prompt: str) -> None:
            type(self).research_calls += 1
            if type(self).research_calls <= 2:
                # 失敗試行の履歴が次のAgentへ持ち越されないことも同時に確認する。
                self.research_count += 1
                self.messages = [{"content": [{"text": "partial history"}]}]
                raise RuntimeError("event loop failed") from _transient_api_error()
            super().__call__(prompt)

    monkeypatch.setattr(agent_module, "Agent", _TransientThenSuccessfulAgent)
    FakeAgent.structured_results = [_quiz_item()]

    item, source_texts = agent_module._generate_quiz_with_docs("問題生成プロンプト")

    assert item.question.question == "設問はどれか。"
    assert source_texts == ["調査済みAWSドキュメント原文"]
    assert client.enter_count == 1
    assert client.list_tools_count == 1
    assert len(FakeAgent.instances) == 3
    assert [instance.research_count for instance in FakeAgent.instances] == [1, 1, 1]
    assert (
        len({id(instance.kwargs["hooks"][0]) for instance in FakeAgent.instances}) == 3
    )


def test_research_transient_model_error_exhaustion_reports_attempt_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_research(monkeypatch)
    monkeypatch.setenv("AGENT_RESEARCH_RETRIES", "1")
    monkeypatch.setattr(agent_module.time, "sleep", lambda seconds: None)

    class _AlwaysTransientAgent(FakeAgent):
        def __call__(self, prompt: str) -> None:
            self.messages = _search_only_messages()
            raise RuntimeError("event loop failed") from _transient_api_error()

    monkeypatch.setattr(agent_module, "Agent", _AlwaysTransientAgent)

    with pytest.raises(agent_module.DocsResearchError) as exc_info:
        agent_module._generate_quiz_with_docs("問題生成プロンプト")

    assert exc_info.value.cause_kind == "model"
    assert exc_info.value.original_exception_type == "APIError"
    assert exc_info.value.successful_tool_calls == 2
    assert exc_info.value.research_attempts == 2
    assert len(FakeAgent.instances) == 2


def test_mcp_list_tools_failure_is_not_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _FailingMCPClient(FakeMCPClient):
        def list_tools_sync(self) -> list[Any]:
            self.list_tools_count += 1
            raise RuntimeError("list_tools failed")

    client = _FailingMCPClient()
    monkeypatch.setattr(agent_module, "_docs_mcp_client", lambda: client)
    monkeypatch.setattr(agent_module, "_model", lambda: object())
    monkeypatch.setenv("AGENT_RESEARCH_RETRIES", "3")

    with pytest.raises(agent_module.DocsResearchError) as exc_info:
        agent_module._generate_quiz_with_docs("問題生成プロンプト")

    assert exc_info.value.cause_kind == "mcp"
    assert exc_info.value.original_exception_type == "RuntimeError"
    assert exc_info.value.research_attempts == 0
    assert client.list_tools_count == 1
    assert FakeAgent.instances == []


def test_structured_quiz_with_retries_raises_quota_exhausted_without_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_module.time, "sleep", lambda seconds: None)

    class _RateLimitedAgent:
        def __init__(self) -> None:
            self.structured_count = 0

        def structured_output(
            self, output_model: type[QuizItem], prompt: str
        ) -> QuizItem:
            self.structured_count += 1
            raise _FakeRateLimitError()

    fake_agent = _RateLimitedAgent()

    with pytest.raises(agent_module.QuotaExhaustedError):
        agent_module._structured_quiz_with_retries(fake_agent, retries=2)

    assert fake_agent.structured_count == 1


def test_generate_helper_raises_quota_exhausted_without_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_module.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(agent_module, "_model", lambda: object())

    class _RateLimitedAgent:
        def __init__(self, **kwargs: Any) -> None:
            self.calls = 0

        def structured_output(
            self, output_model: type[QuizItem], prompt: str
        ) -> QuizItem:
            self.calls += 1
            raise _FakeRateLimitError()

    created: list[_RateLimitedAgent] = []

    def _factory(**kwargs: Any) -> _RateLimitedAgent:
        instance = _RateLimitedAgent(**kwargs)
        created.append(instance)
        return instance

    monkeypatch.setattr(agent_module, "Agent", _factory)

    with pytest.raises(agent_module.QuotaExhaustedError):
        agent_module._generate(
            "system prompt", QuizItem, "問題生成プロンプト", retries=2
        )

    assert len(created) == 1
    assert created[0].calls == 1


def test_research_phase_429_raises_quota_exhausted_without_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_research(monkeypatch)
    monkeypatch.setenv("AGENT_RESEARCH_RETRIES", "3")
    monkeypatch.setattr(agent_module, "Agent", _RateLimitedResearchAgent)
    monkeypatch.setattr(
        agent_module,
        "_generate",
        lambda *args, **kwargs: pytest.fail(
            "ドキュメントなし生成へフォールバックしないこと"
        ),
    )

    with pytest.raises(agent_module.QuotaExhaustedError):
        agent_module.generate_quiz("saa")

    assert len(FakeAgent.instances) == 1


def test_research_retry_kwargs_shortens_throttle_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AGENT_MODEL_RETRY_ATTEMPTS", raising=False)
    kwargs = agent_module._research_retry_kwargs()
    assert kwargs["retry_strategy"]._max_attempts == 3

    monkeypatch.setenv("AGENT_MODEL_RETRY_ATTEMPTS", "2")
    kwargs = agent_module._research_retry_kwargs()
    assert kwargs["retry_strategy"]._max_attempts == 2


# --- Phase 1-a: _gate_guard_content ------------------------------------------


def test_gate_guard_content_excludes_correct_label_line() -> None:
    item = _quiz_item()

    content = agent_module._gate_guard_content(item)

    assert "正解: " not in content


def test_gate_guard_content_uses_grounding_claim_instead_of_correct_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AGENT_GATE_INCLUDE_OVERVIEW", raising=False)
    item = _quiz_item()

    content = agent_module._gate_guard_content(item)

    assert "A: 正解" in content
    assert item.explanation.grounding_claim_en in content
    assert item.explanation.correct_reason not in content
    assert "概要" not in content


def test_gate_guard_content_includes_overview_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENT_GATE_INCLUDE_OVERVIEW", "1")
    item = _quiz_item()

    content = agent_module._gate_guard_content(item)

    assert "概要" in content


def test_gate_guard_content_claim_only_drops_japanese_option_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """claim_only 腕では日本語の正解選択肢本文とラベル接頭辞を含めない。"""
    monkeypatch.setenv("AGENT_GATE_GUARD_CONTENT", "claim_only")
    monkeypatch.delenv("AGENT_GATE_INCLUDE_OVERVIEW", raising=False)
    item = _quiz_item()

    content = agent_module._gate_guard_content(item)

    assert content == item.explanation.grounding_claim_en
    assert "A: " not in content
    assert "正解" not in content


def test_gate_guard_content_defaults_to_mixed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """未設定なら従来どおり日本語の正解選択肢本文を含む(既定の腕を変えない)。"""
    monkeypatch.delenv("AGENT_GATE_GUARD_CONTENT", raising=False)
    monkeypatch.delenv("AGENT_GATE_INCLUDE_OVERVIEW", raising=False)
    item = _quiz_item()

    content = agent_module._gate_guard_content(item)

    assert "A: 正解" in content
    assert item.explanation.grounding_claim_en in content


# --- Phase 1-b: _tool_result_texts -------------------------------------------


def test_tool_result_texts_only_includes_successful_read_documentation() -> None:
    messages = [
        {
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "t1",
                        "name": "search_documentation",
                        "input": {},
                    }
                },
                {
                    "toolUse": {
                        "toolUseId": "t2",
                        "name": "read_documentation",
                        "input": {},
                    }
                },
                {
                    "toolUse": {
                        "toolUseId": "t3",
                        "name": "read_documentation",
                        "input": {},
                    }
                },
            ]
        },
        {
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t1",
                        "status": "success",
                        "content": [{"text": "検索結果JSON(ノイズ)"}],
                    }
                },
                {
                    "toolResult": {
                        "toolUseId": "t2",
                        "status": "success",
                        "content": [{"text": "ドキュメント原文"}],
                    }
                },
                {
                    "toolResult": {
                        "toolUseId": "t3",
                        "status": "error",
                        "content": [{"text": "ツール上限によるキャンセル"}],
                    }
                },
            ]
        },
    ]

    texts = agent_module._tool_result_texts(messages)

    assert texts == ["ドキュメント原文"]


def test_tool_result_texts_does_not_fall_back_to_search_results() -> None:
    messages = [
        {
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "t1",
                        "name": "search_documentation",
                        "input": {},
                    }
                },
            ]
        },
        {
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t1",
                        "status": "success",
                        "content": [{"text": "検索結果JSON"}],
                    }
                },
            ]
        },
    ]

    texts = agent_module._tool_result_texts(messages)

    # issue #77: search-onlyを根拠扱いする旧フォールバックを撤去した。
    assert texts == []


def test_generate_quiz_with_docs_uses_read_documentation_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # issue #77に合わせ、FakeAgentも実際のtoolUse/toolResult対応を持つ履歴にした。
    client = _mock_research(monkeypatch)
    FakeAgent.structured_results = [_quiz_item()]

    item, source_texts = agent_module._generate_quiz_with_docs("問題生成プロンプト")

    assert item.question.question == "設問はどれか。"
    assert source_texts == ["調査済みAWSドキュメント原文"]
    assert client.enter_count == 1


def _no_tool_messages() -> list[Any]:
    return [{"content": [{"text": "ツールを使わず回答"}]}]


def _search_only_messages() -> list[Any]:
    return [
        {
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "search-1",
                        "name": "search_documentation",
                        "input": {},
                    }
                }
            ]
        },
        {
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "search-1",
                        "status": "success",
                        "content": [{"text": "検索結果JSON"}],
                    }
                }
            ]
        },
    ]


def _mock_empty_research(monkeypatch: pytest.MonkeyPatch, messages: list[Any]) -> None:
    @contextmanager
    def researched_agent(prompt: str) -> Any:
        agent = FakeAgent()
        agent.messages = messages
        yield agent, []

    monkeypatch.setattr(agent_module, "_researched_agent", researched_agent)
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: True)
    monkeypatch.setattr(agent_module, "gate_retries", lambda: 1)
    FakeAgent.structured_results = [_quiz_item()]


@pytest.mark.parametrize(
    ("messages", "detail"),
    [
        (_no_tool_messages(), "no_tool_calls"),
        (_search_only_messages(), "no_read_documentation"),
    ],
)
def test_empty_research_is_blocked_when_enforced(
    monkeypatch: pytest.MonkeyPatch, messages: list[Any], detail: str
) -> None:
    _mock_empty_research(monkeypatch, messages)
    monkeypatch.setenv("AGENT_GUARDRAIL_ENFORCE", "1")

    with pytest.raises(agent_module.ResearchIncompleteError, match=detail):
        agent_module._generate_quiz_with_docs_and_gate("問題生成プロンプト")

    assert FakeAgent.instances[0].structured_count == 0


@pytest.mark.parametrize(
    ("messages", "detail"),
    [
        (_no_tool_messages(), "no_tool_calls"),
        (_search_only_messages(), "no_read_documentation"),
    ],
)
def test_empty_research_returns_not_run_detail_in_report_mode(
    monkeypatch: pytest.MonkeyPatch, messages: list[Any], detail: str
) -> None:
    _mock_empty_research(monkeypatch, messages)
    monkeypatch.setenv("AGENT_GUARDRAIL_ENFORCE", "0")

    result = agent_module._generate_quiz_with_docs_and_gate("問題生成プロンプト")

    assert result.gate == GateResult(status="not_run", detail=detail)


def test_empty_research_falls_back_when_gate_is_disabled_even_if_enforced(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_empty_research(monkeypatch, _no_tool_messages())
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: False)
    monkeypatch.setenv("AGENT_GUARDRAIL_ENFORCE", "1")

    result = agent_module._generate_quiz_with_docs_and_gate("問題生成プロンプト")

    assert result.gate == GateResult(status="not_run", detail="no_tool_calls")
    assert FakeAgent.instances[0].structured_count == 1


def _docs_research_error() -> agent_module.DocsResearchError:
    return agent_module.DocsResearchError(
        "model",
        RuntimeError("upstream failed"),
        successful_tool_calls=1,
        research_attempts=2,
    )


def test_research_failure_is_blocked_as_dependency_error_when_enforced(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_module, "_docs_mcp_enabled", lambda: True)
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: True)
    monkeypatch.setattr(
        agent_module,
        "_generate_quiz_with_docs_and_gate",
        lambda *args, **kwargs: (_ for _ in ()).throw(_docs_research_error()),
    )
    monkeypatch.setattr(
        agent_module,
        "_generate",
        lambda *args, **kwargs: pytest.fail("強制モードではフォールバックしないこと"),
    )
    monkeypatch.setenv("AGENT_GUARDRAIL_ENFORCE", "1")

    with pytest.raises(agent_module.ResearchFailedError):
        agent_module.generate_quiz("saa")


def test_research_failure_falls_back_when_gate_is_disabled_even_if_enforced(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_module, "_docs_mcp_enabled", lambda: True)
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: False)
    monkeypatch.setattr(
        agent_module,
        "_generate_quiz_with_docs_and_gate",
        lambda *args, **kwargs: (_ for _ in ()).throw(_docs_research_error()),
    )
    monkeypatch.setattr(agent_module, "_generate", lambda *args, **kwargs: _quiz_item())
    monkeypatch.setenv("AGENT_GUARDRAIL_ENFORCE", "1")

    result = agent_module.generate_quiz("saa")

    assert result.gate == GateResult(status="not_run", detail="research_failed")


def test_research_failure_falls_back_with_not_run_detail_and_structured_log(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(agent_module, "_docs_mcp_enabled", lambda: True)
    monkeypatch.setattr(
        agent_module,
        "_generate_quiz_with_docs_and_gate",
        lambda *args, **kwargs: (_ for _ in ()).throw(_docs_research_error()),
    )
    monkeypatch.setattr(agent_module, "_generate", lambda *args, **kwargs: _quiz_item())
    monkeypatch.setenv("AGENT_GUARDRAIL_ENFORCE", "0")

    with caplog.at_level(logging.WARNING, logger="quiz_agent.agent"):
        result = agent_module.generate_quiz("saa")

    assert result.gate == GateResult(status="not_run", detail="research_failed")
    research_logs = [
        json.loads(record.getMessage())
        for record in caplog.records
        if record.getMessage().startswith("{")
        and '"docs_research_failed"' in record.getMessage()
    ]
    assert research_logs == [
        {
            "event": "docs_research_failed",
            "cause_kind": "model",
            "exception_type": "RuntimeError",
            "successful_tool_calls": 1,
            "research_attempts": 2,
            "fallback": True,
        }
    ]


def test_gate_disabled_result_is_logged_and_counted(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _mock_research(monkeypatch)
    FakeAgent.structured_results = [_quiz_item()]
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: False)
    monkeypatch.delenv("AGENT_GATE_METRICS", raising=False)

    result = agent_module._generate_quiz_with_docs_and_gate(
        "問題生成プロンプト", cert="aip"
    )

    assert result.gate == GateResult(status="not_run", detail="gate_disabled")
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["Status"] == "not_run"
    assert payload["GateEvaluationCount"] == 1
    assert payload["Reason"] == "gate_disabled"


def test_docs_mcp_disabled_result_is_logged_and_counted(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(agent_module, "_docs_mcp_enabled", lambda: False)
    monkeypatch.setattr(agent_module, "_generate", lambda *args, **kwargs: _quiz_item())
    monkeypatch.delenv("AGENT_GATE_METRICS", raising=False)

    result = agent_module.generate_quiz("saa")

    assert result.gate == GateResult(status="not_run", detail="docs_mcp_disabled")
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["Status"] == "not_run"
    assert payload["GateEvaluationCount"] == 1
    assert payload["Reason"] == "docs_mcp_disabled"


# --- Phase 2: ゲートブロック後のフィードバック付き再生成 ------------------------


def test_gate_retry_uses_feedback_prompt(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_research(monkeypatch)
    FakeAgent.structured_results = [
        _quiz_item("初回はどれか。"),
        _quiz_item("再生成はどれか。"),
    ]
    gates = iter(
        [
            GateResult(status="failed", detail="grounding=0.1"),
            GateResult(status="passed"),
        ]
    )
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: True)
    monkeypatch.setattr(agent_module, "gate_retries", lambda: 1)
    monkeypatch.setattr(agent_module, "check_grounding", lambda **kwargs: next(gates))

    agent_module._generate_quiz_with_docs_and_gate("問題生成プロンプト")

    assert FakeAgent.instances[0].structured_prompts == [
        agent_module.QUIZ_FROM_RESEARCH_PROMPT,
        agent_module.QUIZ_REGENERATE_FEEDBACK_PROMPT,
    ]


# --- 内容ポリシー違反後の再生成 ----------------------------------------------


def test_content_violation_regenerates_once_after_gate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_research(monkeypatch)
    invalid = _quiz_item("設問に<br>が混入したものはどれか。")
    FakeAgent.structured_results = [invalid, _quiz_item("再生成した設問はどれか。")]
    gate_calls: list[dict[str, Any]] = []
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: True)
    monkeypatch.setattr(agent_module, "gate_retries", lambda: 1)
    monkeypatch.setenv("AGENT_CONTENT_RETRIES", "1")
    events: list[tuple[str, dict[str, int]]] = []

    def pass_gate(**kwargs: Any) -> GateResult:
        gate_calls.append(kwargs)
        return GateResult(status="passed")

    monkeypatch.setattr(agent_module, "check_grounding", pass_gate)

    result = agent_module._generate_quiz_with_docs_and_gate(
        "問題生成プロンプト",
        on_phase=lambda phase, detail: events.append((phase, detail)),
    )

    assert result.item.question.question == "再生成した設問はどれか。"
    assert len(gate_calls) == 1
    assert FakeAgent.instances[0].structured_count == 2
    assert "保存前の内容検証" in FakeAgent.instances[0].structured_prompts[1]
    assert "question.question" in FakeAgent.instances[0].structured_prompts[1]
    assert ("regeneration", {"attempt": 2, "totalAttempts": 2}) in events
    assert events[-1][0] == "complete"


def test_content_violation_fails_closed_after_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_research(monkeypatch)
    FakeAgent.structured_results = [
        _quiz_item("設問に<br>が混入したものはどれか。"),
        _quiz_item("再生成しても<strong>違反</strong>があるのはどれか。"),
    ]
    gate_calls: list[dict[str, Any]] = []
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: True)
    monkeypatch.setattr(agent_module, "gate_retries", lambda: 1)
    monkeypatch.setenv("AGENT_CONTENT_RETRIES", "1")

    def pass_gate(**kwargs: Any) -> GateResult:
        gate_calls.append(kwargs)
        return GateResult(status="passed")

    monkeypatch.setattr(agent_module, "check_grounding", pass_gate)

    with pytest.raises(
        agent_module.ContentPolicyViolationError,
        match=r"question\.question: HTMLタグを含む",
    ):
        agent_module._generate_quiz_with_docs_and_gate("問題生成プロンプト")

    assert len(gate_calls) == 1
    assert FakeAgent.instances[0].structured_count == 2


# --- 決定的品質チェック(#139) -------------------------------------------------
# 拾うのは「回答不能」「読めない」「ラベルが重複して画面が壊れる」といった
# 出題価値がゼロの欠陥なので、content_policy と同じく再生成1回 → fail-closed。
# 再生成の指示は欠陥を名指しする(ADR 0018: 汎用指示は設問を壊す)。


def _defective_item(question: str = "要件は以下のとおりです。") -> QuizItem:
    """問いかけが欠落した回答不能な設問。実測で7/54件observedした型。"""
    return _quiz_item(question)


def test_quality_defect_regenerates_once_with_named_defect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_research(monkeypatch)
    FakeAgent.structured_results = [
        _defective_item(),
        _quiz_item("再生成した設問はどれか。"),
    ]
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: False)
    monkeypatch.setenv("AGENT_CONTENT_RETRIES", "1")
    events: list[tuple[str, dict[str, int]]] = []

    result = agent_module._generate_quiz_with_docs_and_gate(
        "問題生成プロンプト",
        on_phase=lambda phase, detail: events.append((phase, detail)),
    )

    assert result.item.question.question == "再生成した設問はどれか。"
    assert FakeAgent.instances[0].structured_count == 2
    feedback = FakeAgent.instances[0].structured_prompts[1]
    # 欠陥を名指ししていること(汎用的な「作り直してください」にしない)
    assert "問いかけ" in feedback
    # ADR 0018 の教訓: シナリオを削らせない指示が入っていること
    assert "短くしたり削ったり" in feedback
    assert ("regeneration", {"attempt": 2, "totalAttempts": 2}) in events


def test_quality_defect_fails_closed_after_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_research(monkeypatch)
    FakeAgent.structured_results = [
        _defective_item(),
        _defective_item("要件は次のとおり。"),
    ]
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: False)
    monkeypatch.setenv("AGENT_CONTENT_RETRIES", "1")

    with pytest.raises(
        agent_module.QualityDefectError, match="missing_question_prompt"
    ):
        agent_module._generate_quiz_with_docs_and_gate("問題生成プロンプト")

    assert FakeAgent.instances[0].structured_count == 2


def test_quality_defect_error_code_is_content_invalid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ADR 0014 の写像テーブルに既にある content_invalid を流用する。"""
    _mock_research(monkeypatch)
    FakeAgent.structured_results = [_defective_item()]
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: False)
    monkeypatch.setenv("AGENT_CONTENT_RETRIES", "0")

    with pytest.raises(agent_module.QualityDefectError) as excinfo:
        agent_module._generate_quiz_with_docs_and_gate("問題生成プロンプト")

    assert excinfo.value.error_code == "content_invalid"


def test_quality_defect_is_logged_with_defect_codes(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """どの欠陥で落ちたかを prod のログから追えること。"""
    _mock_research(monkeypatch)
    FakeAgent.structured_results = [_defective_item(), _defective_item()]
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: False)
    monkeypatch.setenv("AGENT_CONTENT_RETRIES", "1")

    with (
        caplog.at_level(logging.WARNING, logger="quiz_agent.agent"),
        pytest.raises(agent_module.QualityDefectError),
    ):
        agent_module._generate_quiz_with_docs_and_gate("問題生成プロンプト")

    events = [
        json.loads(record.message)
        for record in caplog.records
        if record.message.startswith("{")
    ]
    quality_events = [e for e in events if e.get("event") == "quality_defect"]
    assert quality_events
    assert quality_events[0]["codes"] == ["missing_question_prompt"]


def test_content_policy_violation_takes_precedence_over_quality_defect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """HTML混入と問いかけ欠落が同時に起きたら、内容ポリシー側の指示を出す。

    どちらの再生成指示も「日本語プレーンテキストで書き直す」を含むが、
    品質欠陥側の指示は設問の維持を強く要求する。両方を1回の指示に混ぜると
    どちらも中途半端になるため、順序を固定する。
    """
    _mock_research(monkeypatch)
    FakeAgent.structured_results = [
        _quiz_item("要件は<br>以下のとおりです。"),
        _quiz_item("再生成した設問はどれか。"),
    ]
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: False)
    monkeypatch.setenv("AGENT_CONTENT_RETRIES", "1")

    agent_module._generate_quiz_with_docs_and_gate("問題生成プロンプト")

    feedback = FakeAgent.instances[0].structured_prompts[1]
    assert "保存前の内容検証" in feedback


def test_content_retry_without_docs_reuses_same_agent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeAgent.structured_results = [
        _quiz_item("設問に<br>が混入したものはどれか。"),
        _quiz_item("再生成した設問はどれか。"),
    ]
    monkeypatch.setattr(agent_module, "Agent", FakeAgent)
    monkeypatch.setattr(agent_module, "_model", lambda: object())
    monkeypatch.setenv("AGENT_CONTENT_RETRIES", "1")

    item = agent_module._generate(
        agent_module.QUIZ_SYSTEM_PROMPT,
        QuizItem,
        "問題生成プロンプト",
    )

    assert item.question.question == "再生成した設問はどれか。"
    assert len(FakeAgent.instances) == 1
    assert FakeAgent.instances[0].structured_count == 2


# --- Phase 0-a: 構造化ログ ----------------------------------------------------


def test_generate_quiz_with_docs_and_gate_logs_passed_result(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    _mock_research(monkeypatch)
    FakeAgent.structured_results = [_quiz_item()]
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: True)
    monkeypatch.setattr(agent_module, "gate_retries", lambda: 1)
    monkeypatch.setattr(
        agent_module,
        "check_grounding",
        lambda **kwargs: GateResult(
            status="passed", grounding_score=0.9, relevance_score=0.8
        ),
    )

    with caplog.at_level(logging.INFO, logger="quiz_agent.agent"):
        result = agent_module._generate_quiz_with_docs_and_gate(
            "問題生成プロンプト", cert="aip"
        )

    assert result.gate.status == "passed"
    gate_logs = [
        json.loads(r.getMessage())
        for r in caplog.records
        if r.getMessage().startswith("{") and '"grounding_gate"' in r.getMessage()
    ]
    assert len(gate_logs) == 1
    assert gate_logs[0] == {
        "event": "grounding_gate",
        "status": "passed",
        "grounding": 0.9,
        "relevance": 0.8,
        "attempt": 1,
        "attempts": 2,
        "cert": "aip",
        "detail": None,
    }


def test_phase_events_follow_generation_and_gate_retry_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_research(monkeypatch)
    FakeAgent.structured_results = [
        _quiz_item("初回はどれか。"),
        _quiz_item("再生成はどれか。"),
    ]
    gates = iter([GateResult(status="failed"), GateResult(status="passed")])
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: True)
    monkeypatch.setattr(agent_module, "gate_retries", lambda: 1)
    monkeypatch.setattr(agent_module, "check_grounding", lambda **kwargs: next(gates))
    events: list[tuple[str, dict[str, int]]] = []

    agent_module._generate_quiz_with_docs_and_gate(
        "問題生成プロンプト",
        on_phase=lambda phase, detail: events.append((phase, detail)),
    )

    assert [phase for phase, _detail in events] == [
        "mcp",
        "research",
        "research",
        "generation",
        "guardrail",
        "regeneration",
        "guardrail",
        "complete",
    ]
    assert events[5][1] == {"attempt": 2, "totalAttempts": 2}


def test_phase_callback_error_does_not_stop_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_module, "_docs_mcp_enabled", lambda: False)
    monkeypatch.setattr(agent_module, "_generate", lambda *args, **kwargs: _quiz_item())

    result = agent_module.generate_quiz(
        "saa",
        on_phase=lambda _phase, _detail: (_ for _ in ()).throw(
            RuntimeError("通知失敗")
        ),
    )

    assert result.item.question.question == "設問はどれか。"


# --- 自己整合ジャッジの配線(#140) ---------------------------------------------
# report-only。判定結果は保存するが生成をブロックしない(ADR 0010 と同じ段階手順)。


def test_generate_quiz_attaches_judge_result(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_research(monkeypatch)
    FakeAgent.structured_results = [_quiz_item()]
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: False)
    judged: list[QuizItem] = []

    def fake_judge(item: QuizItem, cert: str | None = None) -> Any:
        judged.append(item)
        return agent_module.JudgeResult(status="clean", model_id="test/judge")

    monkeypatch.setattr(agent_module, "judge_self_consistency", fake_judge)

    result = agent_module.generate_quiz("aip")

    assert result.judge.status == "clean"
    assert judged == [result.item]


def test_generate_quiz_does_not_block_on_defective_judge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """report-only の間は defective でも生成物を返すこと。"""
    _mock_research(monkeypatch)
    FakeAgent.structured_results = [_quiz_item()]
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: False)
    monkeypatch.setattr(
        agent_module,
        "judge_self_consistency",
        lambda item, cert=None: agent_module.JudgeResult(
            status="defective", detail="ambiguous_correct: AとCが両方正解"
        ),
    )

    result = agent_module.generate_quiz("aip")

    assert result.judge.status == "defective"
    assert result.item.question.question == "設問はどれか。"


def test_judge_runs_on_the_docs_less_fallback_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """調査失敗でフォールバックした経路でもジャッジが走ること。"""
    FakeAgent.structured_results = [_quiz_item()]
    monkeypatch.setattr(agent_module, "Agent", FakeAgent)
    monkeypatch.setattr(agent_module, "_model", lambda: object())
    monkeypatch.setattr(agent_module, "_docs_mcp_enabled", lambda: False)
    monkeypatch.setattr(
        agent_module,
        "judge_self_consistency",
        lambda item, cert=None: agent_module.JudgeResult(
            status="clean", model_id="test/judge"
        ),
    )

    result = agent_module.generate_quiz("aip")

    assert result.judge.status == "clean"


def test_judge_receives_cert(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_research(monkeypatch)
    FakeAgent.structured_results = [_quiz_item()]
    monkeypatch.setattr(agent_module, "gate_enabled", lambda: False)
    seen: list[str | None] = []

    def fake_judge(item: QuizItem, cert: str | None = None) -> Any:
        seen.append(cert)
        return agent_module.JudgeResult(status="clean")

    monkeypatch.setattr(agent_module, "judge_self_consistency", fake_judge)

    agent_module.generate_quiz("aip")

    assert seen == ["aip"]
