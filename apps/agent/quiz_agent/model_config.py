"""モデル設定（環境変数）の解決。

strands 等の重い依存を持たないため、stubモードの server.py からも安全にimportできる。
生成モデルの実行は OpenRouter に一本化している（ADR 0012。Bedrock は Guardrails と
AgentCore Runtime でのみ使い、モデル推論には使わない）。
"""

from __future__ import annotations

import os

DEFAULT_OPENROUTER_MODEL_ID = "nvidia/nemotron-3-ultra-550b-a55b:free"
DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def model_id() -> str:
    return os.environ.get("AGENT_MODEL_ID", DEFAULT_OPENROUTER_MODEL_ID)


def openrouter_base_url() -> str:
    return os.environ.get("AGENT_OPENROUTER_BASE_URL", DEFAULT_OPENROUTER_BASE_URL)
