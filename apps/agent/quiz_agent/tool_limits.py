"""調査ツール(search_documentation / read_documentation)の呼び出し回数の上限強制。

プロンプトで「最大2回まで」等と指示しても、モデルが無視して3〜5回呼ぶことがある
(issue #70)。BeforeToolCallEvent で呼び出し回数を数え、上限を超えたらツール実行
自体を cancel_tool でキャンセルし、その旨をエラーステータスのtool resultとして
モデルに返す(strands 1.45.0 の実装を参照して確認済み)。
"""

from __future__ import annotations

import os
from collections import Counter

from strands.hooks import BeforeToolCallEvent, HookProvider, HookRegistry

# search 2 / read 2。issue #142 で調査対象を「異なる2つのサービス(機能)」にしたため、
# 検索も2回必要になった(1回の検索クエリで無関係な2サービスの仕様は引けない)。
# read は元から2回許可していたので増えていない。**検索1回ぶんはコストが増える**:
# ツール呼び出しは1回につき1モデルターンなので、入力トークンと所要時間が伸びる。
# 生成時間は ADR 0014 の job 締切(10分)に対して実測すること。
DEFAULT_SEARCH_LIMIT = 2
DEFAULT_READ_LIMIT = 2

_CANCEL_MESSAGE = (
    "調査ツールの呼び出し上限に達しました。"
    "これ以上ツールを使わず、ここまでの調査結果で作業を続けてください。"
)


class ToolCallLimiter(HookProvider):
    """ツール名ごとの呼び出し回数に上限を設け、超過分をキャンセルするフック。

    limits に含まれないツール名は無制限。Agent生成ごとに呼び出し回数を数え直す
    必要があるため、Agentインスタンスごとに新しいToolCallLimiterを使うこと。
    """

    def __init__(self, limits: dict[str, int]) -> None:
        self._limits = dict(limits)
        self._counts: Counter[str] = Counter()

    def register_hooks(self, registry: HookRegistry, **kwargs: object) -> None:
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool_call)

    def _on_before_tool_call(self, event: BeforeToolCallEvent) -> None:
        name = event.tool_use["name"]
        limit = self._limits.get(name)
        if limit is None:
            return
        self._counts[name] += 1
        if self._counts[name] > limit:
            event.cancel_tool = _CANCEL_MESSAGE


def docs_tool_limiter() -> ToolCallLimiter:
    """AWSドキュメントMCPツール(search/read)の上限をenvから解決して返す。

    AGENT_DOCS_SEARCH_LIMIT / AGENT_DOCS_READ_LIMIT で既定値を上書きできる。
    """
    search_limit = int(
        os.environ.get("AGENT_DOCS_SEARCH_LIMIT", str(DEFAULT_SEARCH_LIMIT))
    )
    read_limit = int(os.environ.get("AGENT_DOCS_READ_LIMIT", str(DEFAULT_READ_LIMIT)))
    return ToolCallLimiter(
        {
            "search_documentation": search_limit,
            "read_documentation": read_limit,
        }
    )
