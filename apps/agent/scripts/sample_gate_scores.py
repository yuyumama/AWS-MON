"""グラウンディングゲートのスコア分布を採取するバッチスクリプト(フェーズ0-b)。

prod実測の初回通過率が低い(issue #63)ことを受けて、しきい値の再設定を検討する
材料としてグラウンディング/関連度スコアの分布を集める。AGENT_GUARDRAIL_ENFORCE=0
でレポートモードに固定し、ゲートで弾かれても生成は止めない(スコアの記録が目的)。

使い方:
    python scripts/sample_gate_scores.py --n 20 --cert aip
    python scripts/sample_gate_scores.py --n 30 --cert aip --domain d1 --out scores.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import statistics as stats
import sys
import time
from pathlib import Path
from typing import Any

# scripts/ から実行しても quiz_agent パッケージ(apps/agent直下)を解決できるようにする。
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from quiz_agent.agent import generate_quiz  # noqa: E402

# しきい値候補(create_guardrail.py の既定 grounding=0.7 / relevance=0.5 周辺を含む)。
THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7]
MAX_CONSECUTIVE_FAILURES = 3


def _percentile(values: list[float], pct: float) -> float | None:
    """線形補間によるパーセンタイル(0<=pct<=1)。"""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    k = (len(ordered) - 1) * pct
    lower = int(k)
    upper = min(lower + 1, len(ordered) - 1)
    if lower == upper:
        return ordered[lower]
    weight = k - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def _stats_block(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"mean": None, "median": None, "p25": None, "p75": None}
    return {
        "mean": stats.fmean(values),
        "median": stats.median(values),
        "p25": _percentile(values, 0.25),
        "p75": _percentile(values, 0.75),
    }


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    """サンプリング結果を集計する純粋関数(ユニットテスト用に分離)。

    status別件数、grounding/relevanceスコアの mean・median・p25・p75、
    しきい値候補ごとの通過率(そのしきい値以上のスコアだった割合)を返す。
    """
    status_counts: dict[str, int] = {}
    for record in records:
        status = record.get("status") or "error"
        status_counts[status] = status_counts.get(status, 0) + 1

    grounding_values = [
        record["grounding"]
        for record in records
        if isinstance(record.get("grounding"), (int, float))
    ]
    relevance_values = [
        record["relevance"]
        for record in records
        if isinstance(record.get("relevance"), (int, float))
    ]

    threshold_pass_rates: dict[str, dict[str, float | None]] = {}
    for threshold in THRESHOLDS:
        threshold_pass_rates[str(threshold)] = {
            "grounding": (
                sum(1 for v in grounding_values if v >= threshold)
                / len(grounding_values)
                if grounding_values
                else None
            ),
            "relevance": (
                sum(1 for v in relevance_values if v >= threshold)
                / len(relevance_values)
                if relevance_values
                else None
            ),
        }

    return {
        "total": len(records),
        "status_counts": status_counts,
        "grounding": _stats_block(grounding_values),
        "relevance": _stats_block(relevance_values),
        "threshold_pass_rates": threshold_pass_rates,
    }


def _sample_once(cert: str, domain: str | None) -> dict[str, Any]:
    started = time.monotonic()
    try:
        result = generate_quiz(cert, domain)
    except Exception as e:  # noqa: BLE001 - 1回分の失敗として記録して継続する
        return {
            "status": "error",
            "grounding": None,
            "relevance": None,
            "duration_sec": time.monotonic() - started,
            "error": str(e),
        }
    gate = result.gate
    return {
        "status": gate.status,
        "grounding": gate.grounding_score,
        "relevance": gate.relevance_score,
        "duration_sec": time.monotonic() - started,
        "error": None,
    }


def main() -> int:
    # 生成自体をブロックしないレポートモードに固定する(枠を無駄撃ちしないため)。
    os.environ.setdefault("AGENT_GUARDRAIL_ENFORCE", "0")

    parser = argparse.ArgumentParser(
        description="グラウンディングゲートのスコア分布を採取する"
    )
    parser.add_argument("--n", type=int, default=20, help="サンプリング回数(既定20)")
    parser.add_argument("--cert", default="aip", help="資格コード(既定aip)")
    parser.add_argument("--domain", default=None, help="AIPドメイン(省略時は重み付き抽選)")
    parser.add_argument(
        "--sleep", type=float, default=5.0, help="各回の間隔秒(既定5, 日次枠に配慮)"
    )
    parser.add_argument(
        "--out", default=None, help="JSONL出力パス(省略時はファイル出力しない)"
    )
    args = parser.parse_args()

    records: list[dict[str, Any]] = []
    consecutive_failures = 0
    out_fh = open(args.out, "w", encoding="utf-8") if args.out else None
    try:
        for i in range(args.n):
            record = _sample_once(args.cert, args.domain)
            records.append(record)
            print(
                f"[{i + 1}/{args.n}] status={record['status']} "
                f"grounding={record['grounding']} relevance={record['relevance']} "
                f"duration={record['duration_sec']:.1f}s"
                + (f" error={record['error']}" if record["error"] else ""),
                file=sys.stderr,
            )
            if out_fh:
                out_fh.write(json.dumps(record, ensure_ascii=False) + "\n")
                out_fh.flush()

            if record["status"] == "error":
                consecutive_failures += 1
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    print(
                        f"連続{consecutive_failures}回失敗したため中断します",
                        file=sys.stderr,
                    )
                    break
            else:
                consecutive_failures = 0

            if i < args.n - 1:
                time.sleep(args.sleep)
    finally:
        if out_fh:
            out_fh.close()

    summary = summarize(records)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
