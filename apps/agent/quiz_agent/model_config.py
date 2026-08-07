"""モデル設定（環境変数）の解決。

strands 等の重い依存を持たないため、stubモードの server.py からも安全にimportできる。
生成モデルの実行は OpenRouter に一本化している（ADR 0012。Bedrock は Guardrails と
AgentCore Runtime でのみ使い、モデル推論には使わない）。

既定モデルは ADR 0016 で inclusionai/ling-3.0-flash:free に切り替えたが、
2026-08-08 に OpenRouter が同モデルの無料枠を廃止（404）したため
nvidia/nemotron-3-ultra-550b-a55b:free へ切り戻した（ADR 0016の切り戻し手順）。
"""

from __future__ import annotations

import os

DEFAULT_OPENROUTER_MODEL_ID = "nvidia/nemotron-3-ultra-550b-a55b:free"
DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def model_id() -> str:
    return os.environ.get("AGENT_MODEL_ID", DEFAULT_OPENROUTER_MODEL_ID)


def openrouter_base_url() -> str:
    return os.environ.get("AGENT_OPENROUTER_BASE_URL", DEFAULT_OPENROUTER_BASE_URL)
