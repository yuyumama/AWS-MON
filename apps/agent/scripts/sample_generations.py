"""生成をN回まわして結果を採取するバッチスクリプト。

もとは `sample_gate_scores.py` で、Guardrails グラウンディングゲートのスコア分布を
集めるためのものだった（issue #63、ADR 0010）。ADR 0018 でゲートを撤去したため、
**採取対象を「生成された問題そのもの」と「調査完了状況・ジャッジ判定」に置き換えた。**

このスクリプトが解く問題は変わっていない。**推測で変更せず、問題本文を保存したうえで
測る**ことである。旧版は status/score/duration しか保存しておらず、ADR 0010/0015/0016 の
全計測で「低スコアの問題が本当に悪かったか」を後から検証できなかった（ADR 0018 の背景）。

使い方:
    python scripts/sample_generations.py --n 20 --cert aip
    python scripts/sample_generations.py --n 30 --cert aip --domain d1 --out runs.jsonl

出力した JSONL は次のスクリプトにそのまま渡せる。

    python scripts/check_quality_defects.py runs.jsonl --list
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
        "judge_model_id": os.environ.get("AGENT_JUDGE_MODEL_ID"),
        "research_enforce": os.environ.get("AGENT_RESEARCH_ENFORCE", "1"),
        "research_retries": os.environ.get("AGENT_RESEARCH_RETRIES", "2"),
        "content_retries": os.environ.get("AGENT_CONTENT_RETRIES", "1"),
        "docs_search_limit": os.environ.get("AGENT_DOCS_SEARCH_LIMIT", "1"),
        "docs_read_limit": os.environ.get("AGENT_DOCS_READ_LIMIT", "2"),
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
        return {"mean": None, "median": None, "p25": None, "p75": None, "p90": None}
    return {
        "mean": stats.fmean(values),
        "median": stats.median(values),
        "p25": _percentile(values, 0.25),
        "p75": _percentile(values, 0.75),
        "p90": _percentile(values, 0.90),
    }


def _count_by(records: list[dict[str, Any]], key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for record in records:
        value = record.get(key)
        if value is None:
            continue
        counts[str(value)] = counts.get(str(value), 0) + 1
    return counts


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    """サンプリング結果を集計する純粋関数(ユニットテスト用に分離)。

    所要時間は ADR 0014 の job 締切(10分)を脅かしていないかの確認に使う。
    調査プロンプトを変える計測(#142)では、難易度と同時に時間も見ること。
    """
    ok = [r for r in records if r.get("status") == "ok"]
    durations = [
        r["duration_sec"]
        for r in records
        if isinstance(r.get("duration_sec"), (int, float))
    ]

    return {
        "total": len(records),
        "ok": len(ok),
        "status_counts": _count_by(records, "status"),
        "research_counts": _count_by(records, "research_status"),
        "judge_counts": _count_by(ok, "judge_status"),
        "judge_defect_counts": _judge_defect_counts(ok),
        "duration_sec": _stats_block(durations),
    }


def _judge_defect_counts(records: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for record in records:
        for defect_type in record.get("judge_defect_types") or []:
            counts[defect_type] = counts.get(defect_type, 0) + 1
    return counts


def _sample_once(cert: str, domain: str | None) -> dict[str, Any]:
    started = time.monotonic()
    resolved_domain: str | None = domain
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
            "error_code": getattr(e, "error_code", None),
            "cert": cert,
            "domain": resolved_domain,
            "duration_sec": time.monotonic() - started,
            "error": str(e),
        }
    return {
        "status": "ok",
        "research_status": result.research.status,
        "research_detail": result.research.detail,
        "judge_status": result.judge.status,
        "judge_defect_types": [defect.type for defect in result.judge.defects],
        "judge_detail": result.judge.detail,
        # 生成物の良し悪しは本文を読まないと判定できない。丸ごと残す。
        "item": result.item.model_dump(),
        # 調査が的外れだったのかを後から読むために原文も残す。
        "source_texts": list(result.source_texts),
        "source_chars": sum(len(t) for t in result.source_texts),
        "cert": cert,
        "domain": resolved_domain,
        "duration_sec": time.monotonic() - started,
        "error": None,
    }


def main() -> int:
    load_dotenv(AGENT_DIR / ".env")

    parser = argparse.ArgumentParser(description="生成をN回まわして結果を採取する")
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
                f"research={record.get('research_status')} "
                f"judge={record.get('judge_status')} "
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
