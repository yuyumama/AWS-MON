"""文脈的グラウンディングチェック用のBedrockガードレールを作成/更新する(フェーズ3-3)。

作成後に表示される guardrailId を .env の AGENT_GUARDRAIL_ID に設定すると、
生成パスでグラウンディングチェックが有効になる。

しきい値を変えるときは DRAFT を直接運用せず、**バージョンを発行して**
AGENT_GUARDRAIL_VERSION で固定する(切り戻し先を残すため。ADR 0010 決定3)。

使い方:
    # 新規作成
    python scripts/create_guardrail.py [--name aws-mon-quiz-grounding]
        [--grounding-threshold 0.6] [--relevance-threshold 0.5] [--region us-east-1]

    # 現行DRAFTをそのままバージョン発行する(変更前の切り戻し先を確保する)
    python scripts/create_guardrail.py --publish

    # しきい値を更新してバージョン発行する
    python scripts/create_guardrail.py --update --grounding-threshold 0.6 --publish

しきい値の目安: 高いほど厳格(ブロックされやすい)。0〜0.99。
実測分布に基づく既定値の根拠は docs/adr/0010-grounding-gate-thresholds.md。
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Any

import boto3

# バージョン発行はVERSIONING状態を経てREADYになるまで数秒かかる
VERSION_READY_TIMEOUT_SEC = 60
VERSION_POLL_INTERVAL_SEC = 2


def _publish_version(client: Any, guardrail_id: str, description: str) -> str | None:
    """現行DRAFTからバージョンを発行し、READYになるまで待って版番号を返す。"""
    version = client.create_guardrail_version(
        guardrailIdentifier=guardrail_id, description=description
    )["version"]
    print(f"バージョンを発行しました: version={version} (READY待ち)")

    deadline = time.monotonic() + VERSION_READY_TIMEOUT_SEC
    while time.monotonic() < deadline:
        status = client.get_guardrail(
            guardrailIdentifier=guardrail_id, guardrailVersion=version
        )["status"]
        if status == "READY":
            return version
        if status == "FAILED":
            print(f"バージョン {version} の作成に失敗しました", file=sys.stderr)
            return None
        time.sleep(VERSION_POLL_INTERVAL_SEC)

    print(
        f"バージョン {version} がREADYになりませんでした(タイムアウト)。"
        "コンソールで状態を確認してください。",
        file=sys.stderr,
    )
    return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="グラウンディングチェック用ガードレールを作成/更新する"
    )
    parser.add_argument("--name", default="aws-mon-quiz-grounding")
    parser.add_argument("--grounding-threshold", type=float, default=0.6)
    parser.add_argument("--relevance-threshold", type=float, default=0.5)
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    parser.add_argument(
        "--update",
        action="store_true",
        help="同名のガードレールが既にある場合にDRAFTのしきい値を更新する",
    )
    parser.add_argument(
        "--publish",
        action="store_true",
        help="処理後の現行DRAFTからバージョンを発行する(AGENT_GUARDRAIL_VERSION用)",
    )
    parser.add_argument(
        "--version-description",
        default=None,
        help="発行するバージョンの説明(既定: しきい値を記載)",
    )
    args = parser.parse_args()

    client = boto3.client("bedrock", region_name=args.region)

    existing = [
        g
        for g in client.list_guardrails().get("guardrails", [])
        if g.get("name") == args.name
    ]

    if not existing:
        if args.update:
            print(
                f"--update が指定されましたが、ガードレール {args.name} がありません。",
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
        guardrail_id = response["guardrailId"]
        print(f"作成しました: guardrailId={guardrail_id} version={response['version']}")
    else:
        guardrail_id = existing[0]["id"]
        if not args.update and not args.publish:
            print(
                f"同名のガードレールが既にあります: id={guardrail_id}", file=sys.stderr
            )
            print(
                "しきい値を変えるなら --update、現行DRAFTを版として固定するなら --publish を指定してください。",
                file=sys.stderr,
            )
            return 1
        if args.update:
            # UpdateGuardrailは省略した設定を削除するため、既存のDRAFTから引き継ぐ
            draft = client.get_guardrail(
                guardrailIdentifier=guardrail_id, guardrailVersion="DRAFT"
            )
            client.update_guardrail(
                guardrailIdentifier=guardrail_id,
                name=draft["name"],
                description=draft.get("description", ""),
                contextualGroundingPolicyConfig={
                    "filtersConfig": [
                        {"type": "GROUNDING", "threshold": args.grounding_threshold},
                        {"type": "RELEVANCE", "threshold": args.relevance_threshold},
                    ]
                },
                blockedInputMessaging=draft["blockedInputMessaging"],
                blockedOutputsMessaging=draft["blockedOutputsMessaging"],
            )
            print(
                f"DRAFTを更新しました: id={guardrail_id} "
                f"grounding={args.grounding_threshold} relevance={args.relevance_threshold}"
            )

    if not args.publish:
        print("apps/agent/.env に次を追記してください:")
        print(f"  AGENT_GUARDRAIL_ID={guardrail_id}")
        print("  AGENT_GUARDRAIL_VERSION=DRAFT")
        return 0

    current = client.get_guardrail(
        guardrailIdentifier=guardrail_id, guardrailVersion="DRAFT"
    )
    thresholds = {
        f["type"]: f["threshold"]
        for f in current.get("contextualGroundingPolicy", {}).get("filters", [])
    }
    description = args.version_description or (
        f"grounding={thresholds.get('GROUNDING')} relevance={thresholds.get('RELEVANCE')}"
    )
    version = _publish_version(client, guardrail_id, description)
    if version is None:
        return 1

    print(f"READYになりました: version={version} ({description})")
    print("環境変数に次を設定してください:")
    print(f"  AGENT_GUARDRAIL_ID={guardrail_id}")
    print(f"  AGENT_GUARDRAIL_VERSION={version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
