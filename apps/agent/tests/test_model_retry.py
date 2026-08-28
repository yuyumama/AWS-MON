"""モデル呼び出し単位の一過性エラー再試行フックの試験。

prod で発現したバグの再現試験である(2026-08-28)。OpenRouter が
`HTTP 200 + {"error": {"code": 502}}` を返したとき、strands 既定の
ModelRetryStrategy は ModelThrottledException 以外を再試行しないため
調査ターンごと落ちていた。外側は Agent を作り直すので、**それまでに成功した
ツール呼び出し(実測で最大8回)を丸ごと捨てて約150秒やり直していた**。

このフックが守る不変条件は1つだけ:
**一過性のモデルエラーでは会話履歴を捨てず、同じモデル呼び出しをやり直す。**
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
from openai import APIError
from strands.hooks import AfterModelCallEvent, HookRegistry

from quiz_agent.model_retry import (
    DEFAULT_BUDGET_SECONDS,
    DEFAULT_MAX_ATTEMPTS,
    TransientModelRetry,
    research_budget_seconds,
    transient_model_retry,
)


class _FakeClock:
    """単調増加時計。sleep した秒数ぶんだけ進む。"""

    def __init__(self) -> None:
        self.now = 0.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def _transient_api_error() -> APIError:
    """OpenRouter の 200+error ボディが openai SDK から出てくる形。

    status_code を持たない APIError になるのが本番と同じ性質である。
    """
    return APIError(
        "Upstream error from Nvidia: Service temporarily overloaded",
        request=httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions"),
        body={"error": {"message": "Service temporarily overloaded", "code": 502}},
    )


class _FakeRateLimitError(Exception):
    status_code = 429


def _retry(
    clock: _FakeClock | None = None, **kwargs: Any
) -> tuple[TransientModelRetry, _FakeClock]:
    clock = clock or _FakeClock()
    kwargs.setdefault("deadline", DEFAULT_BUDGET_SECONDS)
    hook = TransientModelRetry(clock=clock, sleep=clock.sleep, **kwargs)
    return hook, clock


def _fire(
    hook: TransientModelRetry,
    exception: Exception | None = None,
    *,
    retry: bool = False,
) -> AfterModelCallEvent:
    """フックを登録した registry 経由で AfterModelCallEvent を発火する。

    strands のイベントループは invoke_callbacks_async を使うため、非同期
    コールバックとして呼べることもここで担保する(同期実装だと
    asyncio.sleep でイベントループを止めてしまう)。
    """
    registry = HookRegistry()
    registry.add_hook(hook)
    event = AfterModelCallEvent(
        agent=object(),
        invocation_state={},
        exception=exception,
    )
    if retry:
        event.retry = True
    asyncio.run(registry.invoke_callbacks_async(event))
    return event


def test_retries_statusless_api_error() -> None:
    """本番で落ちた例外そのもので再試行が立つ。"""
    hook, clock = _retry()

    event = _fire(hook, _transient_api_error())

    assert event.retry is True
    assert hook.retry_count == 1
    assert clock.slept  # バックオフを挟んでいる


def test_does_not_retry_rate_limit() -> None:
    """429 は拾わない。

    日次枠切れは待っても回復せず、既存の QuotaExhaustedError 経路
    (フォールバックも再試行もしない)を殺してはならない。
    """
    hook, _ = _retry()

    event = _fire(hook, _FakeRateLimitError("OpenRouter 429"))

    assert event.retry is False
    assert hook.retry_count == 0


def test_does_not_retry_api_error_with_status_code() -> None:
    """status_code を持つ APIError は一過性と見なさない。"""
    error = _transient_api_error()
    error.status_code = 500  # type: ignore[attr-defined]
    hook, _ = _retry()

    event = _fire(hook, error)

    assert event.retry is False


def test_does_not_retry_unrelated_exception() -> None:
    hook, _ = _retry()

    event = _fire(hook, ValueError("スキーマ検証に失敗"))

    assert event.retry is False


def test_stops_at_max_attempts() -> None:
    """max_attempts は strands と同じ「初回を含む総試行回数」。

    4 なら再試行は3回まで。
    """
    hook, _ = _retry(max_attempts=4)

    for _ in range(3):
        assert _fire(hook, _transient_api_error()).retry is True

    assert _fire(hook, _transient_api_error()).retry is False
    assert hook.retry_count == 3


def test_backoff_grows_and_is_capped() -> None:
    hook, clock = _retry(max_attempts=6, initial_delay=3.0, max_delay=12.0)

    for _ in range(5):
        _fire(hook, _transient_api_error())

    assert clock.slept == [3.0, 6.0, 12.0, 12.0, 12.0]


def test_attempt_counter_resets_after_success() -> None:
    """成功したらカウンタを戻す。1回の調査ターンで何度も粘れるようにする。"""
    hook, _ = _retry(max_attempts=2)

    assert _fire(hook, _transient_api_error()).retry is True
    assert _fire(hook, _transient_api_error()).retry is False

    _fire(hook, None)  # モデル呼び出しが成功した

    assert _fire(hook, _transient_api_error()).retry is True


def test_does_not_retry_when_budget_exhausted() -> None:
    """実時間予算を超えたら、試行回数が残っていても諦める。

    これが無いと上流が恒常的に壊れているとき延々と粘り、ジョブ締切
    (10分)を超えて aborted になる。
    """
    clock = _FakeClock()
    hook, _ = _retry(clock, deadline=100.0, max_attempts=99)

    assert _fire(hook, _transient_api_error()).retry is True

    clock.now = 101.0
    event = _fire(hook, _transient_api_error())

    assert event.retry is False
    assert hook.budget_exhausted is True


def test_budget_not_exhausted_when_attempts_run_out() -> None:
    """回数切れと予算切れを取り違えない(失敗ログで区別するため)。"""
    hook, _ = _retry(deadline=10_000.0, max_attempts=2)

    _fire(hook, _transient_api_error())
    _fire(hook, _transient_api_error())

    assert hook.budget_exhausted is False


def test_skips_when_another_hook_already_requested_retry() -> None:
    """既定の ModelRetryStrategy と併用しても二重に待たない。"""
    hook, clock = _retry()

    event = _fire(hook, _transient_api_error(), retry=True)

    assert event.retry is True
    assert hook.retry_count == 0
    assert clock.slept == []


def test_no_exception_does_not_retry() -> None:
    hook, _ = _retry()

    assert _fire(hook, None).retry is False


def test_factory_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENT_RESEARCH_BUDGET_SECONDS", raising=False)
    monkeypatch.delenv("AGENT_TRANSIENT_RETRY_ATTEMPTS", raising=False)

    # 実測(2026-08-14 prod)で調査フェーズは最大368秒かかっていた。
    # 300秒だと成功するはずの生成を予算切れで落とす。
    assert research_budget_seconds() == 420.0
    assert DEFAULT_BUDGET_SECONDS == 420.0
    assert DEFAULT_MAX_ATTEMPTS == 4

    hook = transient_model_retry(deadline=1.0)
    assert isinstance(hook, TransientModelRetry)


def test_factory_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_RESEARCH_BUDGET_SECONDS", "60")
    monkeypatch.setenv("AGENT_TRANSIENT_RETRY_ATTEMPTS", "2")

    assert research_budget_seconds() == 60.0

    clock = _FakeClock()
    hook = transient_model_retry(deadline=10_000.0, clock=clock, sleep=clock.sleep)

    assert _fire(hook, _transient_api_error()).retry is True
    assert _fire(hook, _transient_api_error()).retry is False
