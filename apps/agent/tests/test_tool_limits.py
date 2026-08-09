from __future__ import annotations

import pytest
from strands.hooks import BeforeToolCallEvent, HookRegistry

from quiz_agent.tool_limits import ToolCallLimiter, docs_tool_limiter


def _event(tool_name: str) -> BeforeToolCallEvent:
    return BeforeToolCallEvent(
        agent=object(),
        selected_tool=None,
        tool_use={"toolUseId": "dummy", "name": tool_name, "input": {}},
        invocation_state={},
    )


def _register(limiter: ToolCallLimiter) -> HookRegistry:
    registry = HookRegistry()
    registry.add_hook(limiter)
    return registry


def test_read_documentation_cancelled_on_third_call() -> None:
    registry = _register(ToolCallLimiter({"read_documentation": 2}))

    for _ in range(2):
        event = _event("read_documentation")
        registry.invoke_callbacks(event)
        assert event.cancel_tool is False

    event = _event("read_documentation")
    registry.invoke_callbacks(event)
    assert isinstance(event.cancel_tool, str)
    assert event.cancel_tool


def test_search_documentation_cancelled_on_second_call() -> None:
    registry = _register(ToolCallLimiter({"search_documentation": 1}))

    event = _event("search_documentation")
    registry.invoke_callbacks(event)
    assert event.cancel_tool is False

    event = _event("search_documentation")
    registry.invoke_callbacks(event)
    assert isinstance(event.cancel_tool, str)


def test_tool_without_limit_is_unlimited() -> None:
    registry = _register(ToolCallLimiter({"read_documentation": 1}))

    for _ in range(5):
        event = _event("some_other_tool")
        registry.invoke_callbacks(event)
        assert event.cancel_tool is False


def test_docs_tool_limiter_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_DOCS_SEARCH_LIMIT", "3")
    monkeypatch.setenv("AGENT_DOCS_READ_LIMIT", "5")

    registry = _register(docs_tool_limiter())

    for _ in range(3):
        event = _event("search_documentation")
        registry.invoke_callbacks(event)
        assert event.cancel_tool is False
    event = _event("search_documentation")
    registry.invoke_callbacks(event)
    assert isinstance(event.cancel_tool, str)

    for _ in range(5):
        event = _event("read_documentation")
        registry.invoke_callbacks(event)
        assert event.cancel_tool is False
    event = _event("read_documentation")
    registry.invoke_callbacks(event)
    assert isinstance(event.cancel_tool, str)


def test_docs_tool_limiter_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENT_DOCS_SEARCH_LIMIT", raising=False)
    monkeypatch.delenv("AGENT_DOCS_READ_LIMIT", raising=False)

    registry = _register(docs_tool_limiter())

    # issue #142 で調査対象を「異なる2つのサービス(機能)」にしたため search も2回。
    # 1回の検索クエリで無関係な2サービスの仕様は引けない。
    for _ in range(2):
        event = _event("search_documentation")
        registry.invoke_callbacks(event)
        assert event.cancel_tool is False
    event = _event("search_documentation")
    registry.invoke_callbacks(event)
    assert isinstance(event.cancel_tool, str)

    for _ in range(2):
        event = _event("read_documentation")
        registry.invoke_callbacks(event)
        assert event.cancel_tool is False
    event = _event("read_documentation")
    registry.invoke_callbacks(event)
    assert isinstance(event.cancel_tool, str)
