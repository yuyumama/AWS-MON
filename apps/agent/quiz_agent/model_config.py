"""モデル設定（環境変数）の解決。

strands 等の重い依存を持たないため、stubモードの server.py からも安全にimportできる。
生成モデルの実行は OpenRouter に一本化している（ADR 0012。Bedrock は AgentCore
Runtime のホスティングでのみ使い、モデル推論には使わない。Guardrails も ADR 0018 の
ゲート撤去で呼ばなくなった）。

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


def openrouter_api_key() -> str:
    """環境変数を優先し、未設定ならSSM SecureStringからAPIキーを取得する。

    生成モデル（agent.py）と自己整合ジャッジ（judge.py）の両方から使うため、
    どちらにも依存しないこのモジュールに置く。boto3 は関数内でimportするので、
    strands を持たない呼び出し元からも安全にimportできる性質は保たれる。
    """
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if api_key:
        return api_key

    parameter_name = os.environ.get("OPENROUTER_API_KEY_PARAM", "").strip()
    if not parameter_name:
        raise RuntimeError(
            "OpenRouter APIキーが未設定です。OPENROUTER_API_KEY または "
            "OPENROUTER_API_KEY_PARAM を設定してください"
        )

    try:
        import boto3

        response = boto3.client(
            "ssm", region_name=os.environ.get("AWS_REGION", "us-east-1")
        ).get_parameter(Name=parameter_name, WithDecryption=True)
        api_key = response["Parameter"]["Value"].strip()
    except Exception as e:  # noqa: BLE001 - 取得失敗時は生成を止める
        raise RuntimeError(
            f"SSM Parameter StoreからOpenRouter APIキーを取得できませんでした: "
            f"{parameter_name}"
        ) from e

    if not api_key:
        raise RuntimeError(
            f"SSM Parameter StoreのOpenRouter APIキーが空です: {parameter_name}"
        )
    return api_key
