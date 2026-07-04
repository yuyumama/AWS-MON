"""ローカル実行用CLI。

使い方:
    python -m quiz_agent.cli --cert aip --domain all
    python -m quiz_agent.cli --cert saa
"""

import argparse
import json
import sys

from dotenv import load_dotenv

from .agent import generate_quiz
from .certs import AIP_DOMAINS, CERT_FULL_NAMES
from .schema import Explanation, Question


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
        choices=[d.value for d in AIP_DOMAINS],
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
        result = generate_quiz(args.cert, args.domain)
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
