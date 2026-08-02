"""モデルプロバイダ設定（環境変数）の解決。

strands 等の重い依存を持たないため、stubモードの server.py からも安全にimportできる。
プロバイダは AGENT_MODEL_PROVIDER で切り替える（openrouter が既定）。
"""

from __future__ import annotations

import os

DEFAULT_BEDROCK_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
DEFAULT_OPENROUTER_MODEL_ID = "nvidia/nemotron-3-ultra-550b-a55b:free"
DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def model_provider() -> str:
    return os.environ.get("AGENT_MODEL_PROVIDER", "openrouter").strip().lower()


def model_id() -> str:
    if model_provider() == "openrouter":
        return os.environ.get("AGENT_MODEL_ID", DEFAULT_OPENROUTER_MODEL_ID)
    return os.environ.get("BEDROCK_MODEL_ID", DEFAULT_BEDROCK_MODEL_ID)


def openrouter_base_url() -> str:
    return os.environ.get("AGENT_OPENROUTER_BASE_URL", DEFAULT_OPENROUTER_BASE_URL)
