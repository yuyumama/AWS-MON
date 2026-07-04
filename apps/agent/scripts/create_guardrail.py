"""文脈的グラウンディングチェック用のBedrockガードレールを作成する(フェーズ3-3)。

一度きりのセットアップ。作成後に表示される guardrailId を .env の
AGENT_GUARDRAIL_ID に設定すると、生成パスでグラウンディングチェックが有効になる。
(バージョンは既定でDRAFTを使う。しきい値を固定したい場合はコンソールで
バージョンを発行し AGENT_GUARDRAIL_VERSION に設定する)

使い方:
    python scripts/create_guardrail.py [--name aws-mon-quiz-grounding]
        [--grounding-threshold 0.7] [--relevance-threshold 0.5] [--region us-east-1]

しきい値の目安: 高いほど厳格(ブロックされやすい)。0〜0.99。
"""

from __future__ import annotations

import argparse
import os
import sys

import boto3


def main() -> int:
    parser = argparse.ArgumentParser(
        description="グラウンディングチェック用ガードレールを作成する"
    )
    parser.add_argument("--name", default="aws-mon-quiz-grounding")
    parser.add_argument("--grounding-threshold", type=float, default=0.7)
    parser.add_argument("--relevance-threshold", type=float, default=0.5)
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    args = parser.parse_args()

    client = boto3.client("bedrock", region_name=args.region)

    existing = [
        g
        for g in client.list_guardrails().get("guardrails", [])
        if g.get("name") == args.name
    ]
    if existing:
        print(
            f"同名のガードレールが既にあります: id={existing[0]['id']}", file=sys.stderr
        )
        print(
            "しきい値を変えたい場合はコンソールかUpdateGuardrailで更新してください。",
            file=sys.stderr,
        )
        return 1

    response = client.create_guardrail(
        name=args.name,
        description="AWS-MON: 生成問題がAWSドキュメント原文に根拠づくかのインラインゲート",
        contextualGroundingPolicyConfig={
            "filtersConfig": [
                {"type": "GROUNDING", "threshold": args.grounding_threshold},
                {"type": "RELEVANCE", "threshold": args.relevance_threshold},
            ]
        },
        # ApplyGuardrail専用なので実際にユーザーへ返ることはないが必須項目
        blockedInputMessaging="この入力は処理できません。",
        blockedOutputsMessaging="生成された問題はドキュメントに十分に根拠づきませんでした。",
    )

    print(
        f"作成しました: guardrailId={response['guardrailId']} version={response['version']}"
    )
    print("apps/agent/.env に次を追記してください:")
    print(f"  AGENT_GUARDRAIL_ID={response['guardrailId']}")
    print("  AGENT_GUARDRAIL_VERSION=DRAFT")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
