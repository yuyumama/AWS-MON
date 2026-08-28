"""モデル呼び出し単位の一過性エラーを会話履歴を保ったまま再試行する。"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Awaitable, Callable

from strands.hooks import AfterModelCallEvent, HookProvider, HookRegistry

DEFAULT_MAX_ATTEMPTS = 4
DEFAULT_BUDGET_SECONDS = 420.0


class TransientModelRetry(HookProvider):
    """status_codeなしの一過性モデルエラーを同じモデル呼び出し内で再試行する。"""

    def __init__(
        self,
        *,
        deadline: float,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        initial_delay: float = 3.0,
        max_delay: float = 12.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.deadline = deadline
        self.retry_count = 0
        self.budget_exhausted = False
        self._max_attempts = max_attempts
        self._initial_delay = initial_delay
        self._max_delay = max_delay
        self._clock = clock
        self._sleep = sleep
        self._attempt = 0

    def register_hooks(self, registry: HookRegistry, **kwargs: object) -> None:
        registry.add_callback(AfterModelCallEvent, self._on_after_model_call)

    async def _on_after_model_call(self, event: AfterModelCallEvent) -> None:
        if event.retry:
            return

        if event.exception is None:
            self._attempt = 0
            return

        # agent.py も本フックをimportするため、コールバック時までimportを遅らせる。
        from .agent import _is_rate_limit, _is_transient_model_error

        if _is_rate_limit(event.exception):
            return

        if not _is_transient_model_error(event.exception):
            return

        self._attempt += 1
        if self._attempt >= self._max_attempts:
            return

        if self._clock() > self.deadline:
            self.budget_exhausted = True
            return

        delay = min(self._initial_delay * (2 ** (self._attempt - 1)), self._max_delay)
        await self._sleep(delay)
        self.retry_count += 1
        event.retry = True


def research_budget_seconds() -> float:
    """調査フェーズ全体のモデル再試行予算をenvから返す。"""
    return float(
        os.environ.get("AGENT_RESEARCH_BUDGET_SECONDS", str(DEFAULT_BUDGET_SECONDS))
    )


def transient_retry_attempts() -> int:
    """一過性モデルエラーの総試行回数をenvから返す。"""
    return int(
        os.environ.get("AGENT_TRANSIENT_RETRY_ATTEMPTS", str(DEFAULT_MAX_ATTEMPTS))
    )


def transient_model_retry(deadline: float, **kwargs: object) -> TransientModelRetry:
    """envで既定値を解決し、一過性モデルエラー再試行フックを返す。"""
    return TransientModelRetry(
        deadline=deadline,
        max_attempts=transient_retry_attempts(),
        **kwargs,
    )
