"""重複ログの抑制。

`strands.models.openai` の「reasoningContent is not supported in multi-turn
conversations with the Chat Completions API」警告が、同一ターン内で
5〜7回重複して出力されることがある(issue #70)。logging.Filter で
同一メッセージの再出力を一定時間内は捨てる汎用フィルタを提供する。
"""

from __future__ import annotations

import logging
import time


class DuplicateLogFilter(logging.Filter):
    """同一 (levelno, 整形済みメッセージ) が window_seconds 以内に再出力されたら捨てる。"""

    def __init__(self, window_seconds: float = 60.0) -> None:
        super().__init__()
        self._window_seconds = window_seconds
        self._last_seen: dict[tuple[int, str], float] = {}

    def filter(self, record: logging.LogRecord) -> bool:
        key = (record.levelno, record.getMessage())
        now = time.monotonic()
        last_seen = self._last_seen.get(key)
        self._last_seen[key] = now
        if last_seen is not None and (now - last_seen) < self._window_seconds:
            return False
        return True


def suppress_duplicate_strands_warnings(window_seconds: float = 60.0) -> None:
    """strands.models.openai のロガーに重複抑制フィルタを付ける。

    logging のフィルタは発行元ロガー自身に付ける必要があり、ロガー階層を
    遡っては適用されない(rootや親ロガーに付けても効かない)ため、
    警告を出している "strands.models.openai" に直接addFilterする。
    server.py / runtime.py / cli.py の各エントリから呼ばれるため、
    二重登録を避けるよう既に付いていれば何もしない。
    """
    logger = logging.getLogger("strands.models.openai")
    if any(isinstance(f, DuplicateLogFilter) for f in logger.filters):
        return
    logger.addFilter(DuplicateLogFilter(window_seconds=window_seconds))
