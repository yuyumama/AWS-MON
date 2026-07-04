"""AgentCore Evaluations オンライン評価のセットアップ(フェーズ3-2)。

旧 evaluate_question(生成のたびに自己批評を1回呼ぶ方式)の置き換え。
OTel計装(scripts/run_server_otel.sh)で送ったトレースをデータソースに、
LLM-as-a-Judge の組み込み評価者が非同期・継続的に採点する。

前提:
- scripts/setup_observability.sh 実施済み(Transaction Search + ロググループ)
- 実行者のIAMに bedrock-agentcore:*Evaluat* / iam:CreateRole 等の権限

既定の評価者とサンプリング:
- Builtin.Correctness … 問題としての正確さ(プロンプトがクイズ問題を明示的に想定)
- sampling 20% … ジャッジトークン課金を抑えつつ傾向監視する。品質チューニング時は上げる。

同名のオンライン評価設定が既に存在する場合は、作成で失敗させず、
サンプリング率と評価者を更新する。

使い方:
    python scripts/setup_evaluations.py [--sampling 20]
        [--evaluators Builtin.Correctness]
        [--role-arn arn:aws:iam::...:role/AgentCoreEvaluationRole]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import boto3

ROLE_NAME = "AgentCoreEvaluationRole-aws-mon"


def find_online_evaluation_config(control, name: str) -> dict | None:
    """同名のオンライン評価設定を探す(存在しなければNone)。"""
    for page in control.get_paginator("list_online_evaluation_configs").paginate():
        for config in page.get("onlineEvaluationConfigs", []):
            if config["onlineEvaluationConfigName"] == name:
                return config
    return None


def build_data_source_config(log_group: str, service_name: str) -> dict:
    """評価対象のCloudWatch Logsデータソース設定を作る。"""
    return {
        "cloudWatchLogs": {
            "logGroupNames": [log_group],
            "serviceNames": [service_name],
        }
    }


def print_response(message: str, response: dict) -> None:
    """AgentCore APIのレスポンスを人間向けに表示する。"""
    print(message)
    print(
        json.dumps(
            {k: v for k, v in response.items() if k != "ResponseMetadata"},
            ensure_ascii=False,
            indent=2,
            default=str,
        )
    )
    print("結果は CloudWatch > GenAI Observability の Evaluations で確認できる。")


def ensure_execution_role(region: str, account_id: str) -> str:
    """評価サービス用の実行ロールを用意する(存在すればそのまま使う)。

    権限はAWS docs(evaluations-prerequisites)の最小構成:
    トレース読取(Logs) / 結果書込(evaluations/*) / spansのインデックス / judgeモデル呼び出し。
    """
    iam = boto3.client("iam")
    trust_policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
                "Action": "sts:AssumeRole",
                "Condition": {
                    "StringEquals": {
                        "aws:SourceAccount": account_id,
                        "aws:ResourceAccount": account_id,
                    },
                    "ArnLike": {
                        "aws:SourceArn": [
                            f"arn:aws:bedrock-agentcore:{region}:{account_id}:evaluator/*",
                            f"arn:aws:bedrock-agentcore:{region}:{account_id}:online-evaluation-config/*",
                        ]
                    },
                },
            }
        ],
    }
    permissions = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "CloudWatchLogRead",
                "Effect": "Allow",
                "Action": [
                    "logs:DescribeLogGroups",
                    "logs:GetQueryResults",
                    "logs:StartQuery",
                ],
                "Resource": "*",
            },
            {
                "Sid": "CloudWatchLogWrite",
                "Effect": "Allow",
                "Action": [
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                ],
                "Resource": f"arn:aws:logs:{region}:{account_id}:log-group:/aws/bedrock-agentcore/evaluations/*",
            },
            {
                "Sid": "CloudWatchIndexPolicy",
                "Effect": "Allow",
                "Action": ["logs:DescribeIndexPolicies", "logs:PutIndexPolicy"],
                "Resource": [
                    f"arn:aws:logs:{region}:{account_id}:log-group:aws/spans",
                    f"arn:aws:logs:{region}:{account_id}:log-group:aws/spans:*",
                ],
            },
            {
                "Sid": "BedrockInvoke",
                "Effect": "Allow",
                "Action": [
                    "bedrock:InvokeModel",
                    "bedrock:InvokeModelWithResponseStream",
                ],
                "Resource": [
                    f"arn:aws:bedrock:{region}::foundation-model/*",
                    f"arn:aws:bedrock:{region}:{account_id}:inference-profile/*",
                ],
            },
        ],
    }

    created = False
    try:
        role = iam.get_role(RoleName=ROLE_NAME)
        role_arn = role["Role"]["Arn"]
        print(f"既存ロールを使用: {role_arn}")
    except iam.exceptions.NoSuchEntityException:
        role = iam.create_role(
            RoleName=ROLE_NAME,
            AssumeRolePolicyDocument=json.dumps(trust_policy),
            Description="AWS-MON: AgentCore Evaluations online evaluation execution role",
        )
        role_arn = role["Role"]["Arn"]
        created = True
        print(f"ロールを作成: {role_arn}")

    iam.put_role_policy(
        RoleName=ROLE_NAME,
        PolicyName="agentcore-evaluations",
        PolicyDocument=json.dumps(permissions),
    )
    if created:
        print("IAMの伝播を待機中(10秒)...")
        time.sleep(10)
    return role_arn


def main() -> int:
    parser = argparse.ArgumentParser(
        description="オンライン評価設定を作成または更新する"
    )
    parser.add_argument("--name", default="aws_mon_quiz_agent_online_eval")
    parser.add_argument(
        "--log-group",
        default=os.environ.get("AGENT_OTEL_LOG_GROUP", "/aws/aws-mon/quiz-agent"),
        help="OTel計装のログ送信先(run_server_otel.shのAGENT_OTEL_LOG_GROUPと揃える)",
    )
    parser.add_argument(
        "--service-name",
        default=os.environ.get("AGENT_OTEL_SERVICE_NAME", "aws-mon-quiz-agent"),
        help="OTEL_RESOURCE_ATTRIBUTES の service.name と揃える",
    )
    parser.add_argument(
        "--evaluators",
        nargs="+",
        # Faithfulness相当のドキュメント整合チェックは生成時の
        # Guardrailsグラウンディングゲート(quiz_agent/guardrail.py)が
        # 全件・同期で担保しているため、オンライン評価はCorrectnessの傾向監視に絞る。
        default=["Builtin.Correctness"],
        help="使用する評価者ID(既定: Builtin.Correctness)",
    )
    parser.add_argument(
        "--sampling",
        type=float,
        default=20.0,
        help="評価するセッションの割合(%%)。コスト対効果のため既定20.0、品質チューニング時は上げる",
    )
    parser.add_argument("--role-arn", help="既存の実行ロールARN(省略時は作成)")
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    args = parser.parse_args()

    control = boto3.client("bedrock-agentcore-control", region_name=args.region)

    # 評価者IDの検証(タイポや提供状況の変化を早期に検知する)
    try:
        available = {
            e["evaluatorId"]
            for page in control.get_paginator("list_evaluators").paginate()
            for e in page.get("evaluators", [])
        }
        unknown = [e for e in args.evaluators if e not in available]
        if unknown:
            print(f"警告: 一覧に見つからない評価者ID: {unknown}", file=sys.stderr)
            print(f"利用可能: {sorted(available)}", file=sys.stderr)
    except Exception as e:  # noqa: BLE001 - 検証は補助なので失敗しても続行
        print(f"評価者一覧の取得に失敗(続行): {e}", file=sys.stderr)

    existing = find_online_evaluation_config(control, args.name)
    if existing:
        config_id = existing["onlineEvaluationConfigId"]
        update_params = {
            "onlineEvaluationConfigId": config_id,
            "rule": {"samplingConfig": {"samplingPercentage": args.sampling}},
            "dataSourceConfig": build_data_source_config(
                args.log_group, args.service_name
            ),
            "evaluators": [{"evaluatorId": e} for e in args.evaluators],
            "executionStatus": "ENABLED",
        }
        if args.role_arn:
            update_params["evaluationExecutionRoleArn"] = args.role_arn

        response = control.update_online_evaluation_config(**update_params)
        print_response(
            f"既存のオンライン評価設定を更新しました: {args.name} ({config_id})",
            response,
        )
        return 0

    account_id = boto3.client("sts").get_caller_identity()["Account"]
    role_arn = args.role_arn or ensure_execution_role(args.region, account_id)

    response = control.create_online_evaluation_config(
        onlineEvaluationConfigName=args.name,
        description="AWS-MON: クイズ生成トレースの継続品質評価(旧evaluate_questionの置き換え)",
        rule={"samplingConfig": {"samplingPercentage": args.sampling}},
        dataSourceConfig=build_data_source_config(args.log_group, args.service_name),
        evaluators=[{"evaluatorId": e} for e in args.evaluators],
        evaluationExecutionRoleArn=role_arn,
        enableOnCreate=True,
    )

    print_response("オンライン評価設定を作成しました:", response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
