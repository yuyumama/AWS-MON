"""自己整合ジャッジの候補モデルを較正セットで測るスクリプト(#140)。

**議論ではなく較正セットで測ってモデルを決める。**採否基準は先に決めてある。

- defective 9件のうち **8件以上**を検出する
- clean 3件を **1件も弾かない**

偽陽性は生成の無駄撃ちに直結するため、検出率より偽陽性率を重く見る
(ADR 0010 と同じ姿勢)。較正セットは合成負例であり実トラフィックでの精度を
保証しないので、採用後もまず report-only で分布を採る。

候補は OpenRouter 無料で tools と structured_outputs の両方に対応するもの。
**生成モデルと同じものは使わない**(ADR 0007 が「自己批評＝同一モデルへの再質問」の
evaluate_question を一度実装して削除している)。

使い方:
    export OPENROUTER_API_KEY=...
    python scripts/run_judge_calibration.py                     # 既定の4候補
    python scripts/run_judge_calibration.py --model a --model b # 候補を指定
    python scripts/run_judge_calibration.py --out calibration.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:

    def load_dotenv(*args: Any) -> bool:
        return False


AGENT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENT_DIR))

from quiz_agent.judge import judge_self_consistency  # noqa: E402
from quiz_agent.schema import QuizItem  # noqa: E402

CALIBRATION_PATH = AGENT_DIR / "tests" / "fixtures" / "judge_calibration.json"

# issue #140 が挙げた候補。無料モデルは予告なく消えるため、実行時に
# --model で差し替えられるようにしてある。
DEFAULT_CANDIDATES = (
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "openai/gpt-oss-20b:free",
    "nvidia/nemotron-nano-9b-v2:free",
)

MIN_DEFECTIVE_DETECTED = 8
MAX_CLEAN_REJECTED = 0


def load_cases() -> list[dict[str, Any]]:
    payload = json.loads(CALIBRATION_PATH.read_text(encoding="utf-8"))
    return list(payload.get("cases") or [])


def build_item(case: dict[str, Any]) -> QuizItem:
    """較正セットの item を QuizItem にする。"""
    return QuizItem.model_validate(case["item"])


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    """1モデル分の判定結果を採否基準に照らして集計する純粋関数。

    - detected: defective を defective と判定できた件数(真陽性)
    - rejected_clean: clean を defective と判定した件数(偽陽性)
    - type_matched: 真陽性のうち、欠陥型まで言い当てた件数
      欠陥特定型の再生成をするには型が当たっている必要があるため別に数える
    - errored: ジャッジが判定を返せなかった件数(fail-openで clean 扱いにはしない)
    """
    defective = [r for r in records if r["label"] == "defective"]
    clean = [r for r in records if r["label"] == "clean"]

    detected = [r for r in defective if r["status"] == "defective"]
    type_matched = [r for r in detected if r["expected_defect"] in r["defect_types"]]
    rejected_clean = [r for r in clean if r["status"] == "defective"]
    errored = [r for r in records if r["status"] in ("error", "not_run")]

    passes = (
        len(detected) >= MIN_DEFECTIVE_DETECTED
        and len(rejected_clean) <= MAX_CLEAN_REJECTED
        and not errored
    )

    return {
        "defective_total": len(defective),
        "detected": len(detected),
        "type_matched": len(type_matched),
        "clean_total": len(clean),
        "rejected_clean": len(rejected_clean),
        "errored": len(errored),
        "accepted": passes,
    }


def _judge_case(case: dict[str, Any], model: str) -> dict[str, Any]:
    import os

    os.environ["AGENT_JUDGE_MODEL_ID"] = model
    started = time.monotonic()
    result = judge_self_consistency(build_item(case))
    return {
        "model": model,
        "id": case.get("id"),
        "label": case.get("label"),
        "expected_defect": case.get("defect"),
        "status": result.status,
        "defect_types": [defect.type for defect in result.defects],
        "detail": result.detail,
        "duration_sec": time.monotonic() - started,
    }


def main() -> int:
    load_dotenv(AGENT_DIR / ".env")

    parser = argparse.ArgumentParser(
        description="較正セットで自己整合ジャッジの候補モデルを測る"
    )
    parser.add_argument(
        "--model",
        action="append",
        default=None,
        help="候補モデルID(複数指定可)。省略時は issue #140 の4候補",
    )
    parser.add_argument(
        "--sleep", type=float, default=3.0, help="各判定の間隔秒(既定3, 日次枠に配慮)"
    )
    parser.add_argument("--out", default=None, help="JSONL出力パス")
    args = parser.parse_args()

    candidates = args.model or list(DEFAULT_CANDIDATES)
    cases = load_cases()
    if not cases:
        print("較正セットが空です", file=sys.stderr)
        return 1

    summaries: dict[str, dict[str, Any]] = {}
    out_fh = open(args.out, "w", encoding="utf-8") if args.out else None
    try:
        for model in candidates:
            records: list[dict[str, Any]] = []
            for index, case in enumerate(cases):
                record = _judge_case(case, model)
                records.append(record)
                print(
                    f"[{model}] {record['id']}: {record['status']} "
                    f"{record['defect_types']} ({record['duration_sec']:.1f}s)",
                    file=sys.stderr,
                )
                if out_fh:
                    out_fh.write(json.dumps(record, ensure_ascii=False) + "\n")
                    out_fh.flush()
                if index < len(cases) - 1:
                    time.sleep(args.sleep)
            summaries[model] = summarize(records)
    finally:
        if out_fh:
            out_fh.close()

    print()
    print(
        f"採否基準: defective {MIN_DEFECTIVE_DETECTED}件以上を検出し、"
        f"clean の誤検出が {MAX_CLEAN_REJECTED} 件であること"
    )
    print(
        f"{'model':<45} {'検出':>7} {'型一致':>7} {'誤検出':>7} {'判定不能':>9} {'採否':>5}"
    )
    for model, summary in summaries.items():
        print(
            f"{model:<45} "
            f"{summary['detected']:>3}/{summary['defective_total']:<3} "
            f"{summary['type_matched']:>3}/{summary['defective_total']:<3} "
            f"{summary['rejected_clean']:>3}/{summary['clean_total']:<3} "
            f"{summary['errored']:>9} "
            f"{'採用可' if summary['accepted'] else '不可':>5}"
        )
    print()
    print(json.dumps(summaries, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
