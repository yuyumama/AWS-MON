"""ローカル実行用CLI。

使い方:
    python -m quiz_agent.cli --cert aip --domain all
    python -m quiz_agent.cli --cert saa
"""

import argparse
import json
import random
import sys

from dotenv import load_dotenv

from .agent import generate_quiz
from .certs import CERT_FULL_NAMES
from .log_filters import suppress_duplicate_strands_warnings
from .schema import Explanation, Question

# 実験用 CLI の --domain 互換と省略時抽選だけに使うローカル定義。
# 本番経路の定義の正は packages/shared/src/certs.ts にある。
AIP_HARNESS_DOMAINS = {
    "d1": (
        "基盤モデル統合・データ管理・コンプライアンス",
        "Foundation Model Integration, Data Management, and Compliance",
        31,
    ),
    "d2": ("実装と統合", "Implementation and Integration", 26),
    "d3": (
        "AIの安全性・セキュリティ・ガバナンス",
        "AI Safety, Security, and Governance",
        20,
    ),
    "d4": (
        "運用効率と最適化",
        "Operational Efficiency and Optimization for GenAI Applications",
        12,
    ),
    "d5": (
        "テスト・検証・トラブルシューティング",
        "Testing, Validation, and Troubleshooting",
        11,
    ),
}


def _resolve_harness_domain(
    cert: str, domain: str
) -> tuple[str, str | None, str | None]:
    if cert != "aip":
        return domain, None, None
    resolved = domain
    if domain == "all":
        values = list(AIP_HARNESS_DOMAINS)
        resolved = random.choices(
            values,
            weights=[AIP_HARNESS_DOMAINS[value][2] for value in values],
            k=1,
        )[0]
    label, label_en, _weight = AIP_HARNESS_DOMAINS[resolved]
    return resolved, label, label_en


def _print_question(q: Question) -> None:
    type_label = (
        f"複数選択（{len(q.correct)}つ選択）" if q.type == "multiple" else "単一選択"
    )
    print("=" * 70)
    print(f"[{type_label}]")
    print()
    print(q.question)
    print()
    for opt in q.options:
        print(f"  {opt.label}. {opt.text}")
    print()
    print(f"正解: {', '.join(q.correct)}")
    print("=" * 70)


def _print_explanation(ex: Explanation) -> None:
    print("\n--- 解説 ---")
    if ex.overview:
        print(f"\n[概要]\n{ex.overview}")
    if ex.correct_reason:
        print(f"\n[正解の理由]\n{ex.correct_reason}")
    if ex.option_reasons:
        print("\n[各選択肢]")
        for r in ex.option_reasons:
            print(f"  {r.label}. {r.reason}")
    if ex.source:
        print(f"\n[参考資料]\n{ex.source}")


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    suppress_duplicate_strands_warnings()

    parser = argparse.ArgumentParser(description="AWS認定クイズをローカル生成する")
    parser.add_argument(
        "--cert",
        default="aip",
        choices=list(CERT_FULL_NAMES),
        help="資格コード（既定: aip）",
    )
    parser.add_argument(
        "--domain",
        default="all",
        choices=["all", *AIP_HARNESS_DOMAINS],
        help="AIP-C01 のドメイン（既定: all。AIP以外では無視）",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="整形せずJSONで出力する",
    )
    args = parser.parse_args(argv)

    try:
        print(f"問題と解説を生成中... ({CERT_FULL_NAMES[args.cert]})", file=sys.stderr)
        domain, domain_label, domain_label_en = _resolve_harness_domain(
            args.cert, args.domain
        )
        result = generate_quiz(
            args.cert,
            domain,
            domain_label=domain_label,
            domain_label_en=domain_label_en,
        )
        item = result.item
    except Exception as e:  # noqa: BLE001
        print(f"エラー: {e}", file=sys.stderr)
        return 1

    if args.json:
        out = {
            "quiz": item.model_dump(),
            "gate": {
                "status": result.gate.status,
                "groundingScore": result.gate.grounding_score,
                "relevanceScore": result.gate.relevance_score,
                "detail": result.gate.detail,
            },
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    _print_question(item.question)
    _print_explanation(item.explanation)
    if result.gate.status != "not_run":
        print(
            f"\n--- グラウンディングチェック ---\n判定: {result.gate.status}"
            f" (grounding={result.gate.grounding_score}, relevance={result.gate.relevance_score})"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
