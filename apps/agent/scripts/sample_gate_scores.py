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
import importlib.metadata
import json
import os
import random
import statistics as stats
import sys
import time
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:

    def load_dotenv() -> bool:
        return False


# scripts/ から実行しても quiz_agent パッケージ(apps/agent直下)を解決できるようにする。
AGENT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENT_DIR))

from quiz_agent.agent import generate_quiz  # noqa: E402
from quiz_agent.model_config import model_id  # noqa: E402

# しきい値候補(create_guardrail.py の既定 grounding=0.7 / relevance=0.5 周辺を含む)。
THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7]
MAX_CONSECUTIVE_FAILURES = 3
DEPENDENCIES = (
    "strands-agents",
    "openai",
    "awslabs.aws-documentation-mcp-server",
)

# 実験用ハーネスの省略時抽選だけに使うローカル定義。
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
    cert: str, domain: str | None
) -> tuple[str | None, str | None, str | None]:
    if cert != "aip":
        return domain, None, None
    resolved = domain
    if resolved is None or resolved == "all":
        values = list(AIP_HARNESS_DOMAINS)
        resolved = random.choices(
            values,
            weights=[AIP_HARNESS_DOMAINS[value][2] for value in values],
            k=1,
        )[0]
    info = AIP_HARNESS_DOMAINS.get(resolved)
    if info is None:
        return resolved, None, None
    label, label_en, _weight = info
    return resolved, label, label_en


def sampling_metadata() -> dict[str, Any]:
    """再現性のためモデルIDと主要依存バージョンを記録する。"""
    versions: dict[str, str | None] = {}
    for dependency in DEPENDENCIES:
        try:
            versions[dependency] = importlib.metadata.version(dependency)
        except importlib.metadata.PackageNotFoundError:
            versions[dependency] = None
    return {
        "type": "metadata",
        "model_id": model_id(),
        "dependencies": versions,
        # 腕の識別に必要な設定を残す(後から run.log を読み返さずに済むように)。
        "guard_content_mode": os.environ.get("AGENT_GATE_GUARD_CONTENT", "mixed"),
        "guardrail_retries": os.environ.get("AGENT_GUARDRAIL_RETRIES", "1"),
        "guardrail_enforce": os.environ.get("AGENT_GUARDRAIL_ENFORCE", "1"),
        "research_retries": os.environ.get("AGENT_RESEARCH_RETRIES", "2"),
    }


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

    **通過率として読むべきは passed_rate_scored である。**threshold_pass_rates は
    grounding と relevance を軸ごとに独立して集計した値であり、ゲートの合否ではない
    (ゲートは両者の AND で判定する)。ADR 0015 / 0016 はこの区別をせず
    threshold_pass_rates["0.6"]["grounding"] を「初回通過率」として転記しており、
    実際の通過率と最大14ポイントずれていた(issue #143)。
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

    # 分母は threshold_pass_rates と揃える(スコアが取れた件数)。揃えないと
    # 2つの通過率を並べたときに読み手が取り違える。
    scored = len(grounding_values)
    passed = status_counts.get("passed", 0)

    return {
        "total": len(records),
        "scored": scored,
        "status_counts": status_counts,
        # ゲートの合否(grounding と relevance の AND)。過去ADRとの比較にはこれを使う。
        "passed_rate_scored": (passed / scored if scored else None),
        "passed_rate_total": (passed / len(records) if records else None),
        "grounding": _stats_block(grounding_values),
        "relevance": _stats_block(relevance_values),
        # 軸ごとの独立集計。合否ではないので通過率として読まないこと。
        "threshold_pass_rates": threshold_pass_rates,
    }


def _sample_once(cert: str, domain: str | None) -> dict[str, Any]:
    started = time.monotonic()
    try:
        resolved_domain, domain_label, domain_label_en = _resolve_harness_domain(
            cert, domain
        )
        result = generate_quiz(
            cert,
            resolved_domain,
            domain_label,
            domain_label_en,
        )
    except Exception as e:  # noqa: BLE001 - 1回分の失敗として記録して継続する
        return {
            "status": "error",
            "grounding": None,
            "relevance": None,
            "detail": None,
            "duration_sec": time.monotonic() - started,
            "error": str(e),
        }
    # status/grounding/relevance は「初回試行」を表す。AGENT_GUARDRAIL_RETRIES>0 で
    # 回したときも過去ラン(RETRIES=0)と同じ意味で比較でき、summarize() の集計も
    # 初回通過率のままになる。再生成後の結果は final_* と attempts[] に入れる。
    first = result.attempts[0].gate if result.attempts else result.gate
    final = result.gate
    return {
        "status": first.status,
        "grounding": first.grounding_score,
        "relevance": first.relevance_score,
        "detail": first.detail,
        "final_status": final.status,
        "final_grounding": final.grounding_score,
        "final_relevance": final.relevance_score,
        "attempt_count": len(result.attempts),
        # 低群が本当に悪い問題なのか、再生成で良くなったのかを後から読むための本文。
        "attempts": [
            {
                "attempt": a.attempt,
                "status": a.gate.status,
                "grounding": a.gate.grounding_score,
                "relevance": a.gate.relevance_score,
                "item": a.item.model_dump(),
            }
            for a in result.attempts
        ],
        "item": result.item.model_dump(),
        # 低スコアの原因が捏造(H1)か調査の的外れ(H2)かは、実際に取得された原文を
        # 読まないと判別できない。ラベル付けのために丸ごと残す。
        "source_texts": list(result.source_texts),
        "source_chars": sum(len(t) for t in result.source_texts),
        "cert": cert,
        "domain": resolved_domain,
        "duration_sec": time.monotonic() - started,
        "error": None,
    }


def main() -> int:
    # 生成自体をブロックしないレポートモードに固定する(枠を無駄撃ちしないため)。
    # load_dotenv より先に設定する(load_dotenv は既存の環境変数を上書きしないため、
    # .env 側に AGENT_GUARDRAIL_ENFORCE=1 があってもレポートモードのままにできる)。
    os.environ.setdefault("AGENT_GUARDRAIL_ENFORCE", "0")
    # cli.py / server.py と違いこのスクリプトは .env を読んでいなかったため、
    # AGENT_GUARDRAIL_ID や OPENROUTER_API_KEY が未設定のまま実行されていた。
    load_dotenv(AGENT_DIR / ".env")

    parser = argparse.ArgumentParser(
        description="グラウンディングゲートのスコア分布を採取する"
    )
    parser.add_argument("--n", type=int, default=20, help="サンプリング回数(既定20)")
    parser.add_argument("--cert", default="aip", help="資格コード(既定aip)")
    parser.add_argument(
        "--domain", default=None, help="AIPドメイン(省略時は重み付き抽選)"
    )
    parser.add_argument(
        "--sleep", type=float, default=5.0, help="各回の間隔秒(既定5, 日次枠に配慮)"
    )
    parser.add_argument(
        "--out", default=None, help="JSONL出力パス(省略時はファイル出力しない)"
    )
    args = parser.parse_args()

    records: list[dict[str, Any]] = []
    metadata = sampling_metadata()
    consecutive_failures = 0
    out_fh = open(args.out, "w", encoding="utf-8") if args.out else None
    try:
        if out_fh:
            out_fh.write(json.dumps(metadata, ensure_ascii=False) + "\n")
            out_fh.flush()
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
    summary["metadata"] = metadata
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
