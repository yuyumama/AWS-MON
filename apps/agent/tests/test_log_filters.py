from __future__ import annotations

import logging

import pytest

from quiz_agent import log_filters
from quiz_agent.log_filters import (
    DuplicateLogFilter,
    suppress_duplicate_strands_warnings,
)


def _make_record(msg: str, levelno: int = logging.WARNING) -> logging.LogRecord:
    return logging.LogRecord(
        name="test",
        level=levelno,
        pathname=__file__,
        lineno=1,
        msg=msg,
        args=(),
        exc_info=None,
    )


def test_duplicate_message_within_window_is_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    times = iter([100.0, 100.5])
    monkeypatch.setattr(log_filters.time, "monotonic", lambda: next(times))
    log_filter = DuplicateLogFilter(window_seconds=60)

    assert log_filter.filter(_make_record("重複メッセージ")) is True
    assert log_filter.filter(_make_record("重複メッセージ")) is False


def test_different_message_is_not_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    times = iter([100.0, 100.5])
    monkeypatch.setattr(log_filters.time, "monotonic", lambda: next(times))
    log_filter = DuplicateLogFilter(window_seconds=60)

    assert log_filter.filter(_make_record("メッセージA")) is True
    assert log_filter.filter(_make_record("メッセージB")) is True


def test_message_after_window_elapsed_is_not_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    times = iter([100.0, 200.0])
    monkeypatch.setattr(log_filters.time, "monotonic", lambda: next(times))
    log_filter = DuplicateLogFilter(window_seconds=60)

    assert log_filter.filter(_make_record("重複メッセージ")) is True
    assert log_filter.filter(_make_record("重複メッセージ")) is True


def test_suppress_duplicate_strands_warnings_is_idempotent() -> None:
    logger = logging.getLogger("strands.models.openai")
    for f in [f for f in logger.filters if isinstance(f, DuplicateLogFilter)]:
        logger.removeFilter(f)

    try:
        suppress_duplicate_strands_warnings()
        suppress_duplicate_strands_warnings()

        filters = [f for f in logger.filters if isinstance(f, DuplicateLogFilter)]
        assert len(filters) == 1
    finally:
        for f in [f for f in logger.filters if isinstance(f, DuplicateLogFilter)]:
            logger.removeFilter(f)
