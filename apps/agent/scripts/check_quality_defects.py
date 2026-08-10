"""決定的品質チェックを実データ全件に当てて誤検出率を測るスクリプト(#139)。

ADR 0018 の「トレードオフ / 留意」に書いた教訓に対応する。当初の
`katakana_degraded`(ASCII技術語を含まない選択肢が過半数)は prod 7問を完璧に
分離したが、計測46問に当てると3件を誤検出した。**n=7 で決めた閾値は信用できない。**
新しい判定条件を生成パスに繋ぐ前に、必ずこれで実データ全件に当てること。

入力は2種類を受け付ける。

- `sample_generations.py --out` が書いた JSONL(`item` を読む。旧 `sample_gate_scores.py`
  が書いた `attempts[].item` 形式も読める)
- `tests/fixtures/judge_calibration.json`(`cases[].item` を読む)

使い方:
    python scripts/check_quality_defects.py runs.jsonl
    python scripts/check_quality_defects.py --calibration
    python scripts/check_quality_defects.py *.jsonl --list

判定された設問は `--list` で本文を出せる。**検出が誤検出かどうかは人が読んで
決める。**このスクリプトは件数と本文を出すだけで、正解ラベルは持たない。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterator

AGENT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENT_DIR))

from quiz_agent.quality_checks import find_quality_defects  # noqa: E402
from quiz_agent.schema import QuizItem  # noqa: E402

CALIBRATION_PATH = AGENT_DIR / "tests" / "fixtures" / "judge_calibration.json"


def _iter_jsonl_items(path: Path) -> Iterator[tuple[str, dict[str, Any]]]:
    """JSONLの各行から item を取り出す。再生成前の試行も1件として数える。"""
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        line = line.strip()
        if not line:
            continue
        record = json.loads(line)
        if record.get("type") == "metadata":
            continue
        for attempt in record.get("attempts") or []:
            item = attempt.get("item")
            if isinstance(item, dict):
                yield f"{path.name}:{line_number}#attempt{attempt.get('attempt')}", item
        # attempts があるときの最終 item は最後の試行と同一なので二重に数えない。
        if not record.get("attempts") and isinstance(record.get("item"), dict):
            yield f"{path.name}:{line_number}", record["item"]


def _iter_calibration_items(path: Path) -> Iterator[tuple[str, dict[str, Any]]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    for case in payload.get("cases") or []:
        item = case.get("item")
        if isinstance(item, dict):
            yield f"{case.get('id')}({case.get('label')})", item


def _load_items(paths: list[Path], calibration: bool) -> list[tuple[str, QuizItem]]:
    sources: list[Iterator[tuple[str, dict[str, Any]]]] = [
        _iter_jsonl_items(path) for path in paths
    ]
    if calibration:
        sources.append(_iter_calibration_items(CALIBRATION_PATH))

    items: list[tuple[str, QuizItem]] = []
    skipped = 0
    for source in sources:
        for label, raw in source:
            try:
                items.append((label, QuizItem.model_validate(raw)))
            except Exception:  # noqa: BLE001 - スキーマ違反は集計対象外として数える
                skipped += 1
    if skipped:
        print(f"スキーマ検証に失敗して除外: {skipped}件", file=sys.stderr)
    return items


def main() -> int:
    parser = argparse.ArgumentParser(
        description="決定的品質チェックを実データに当てて検出件数を出す"
    )
    parser.add_argument(
        "paths", nargs="*", type=Path, help="sample_generations.py の JSONL"
    )
    parser.add_argument(
        "--calibration",
        action="store_true",
        help="tests/fixtures/judge_calibration.json も対象に含める",
    )
    parser.add_argument(
        "--list", action="store_true", help="検出した設問の本文を表示する"
    )
    args = parser.parse_args()

    if not args.paths and not args.calibration:
        parser.error("JSONLのパスか --calibration のどちらかを指定してください")

    items = _load_items(args.paths, args.calibration)
    if not items:
        print("対象データがありません", file=sys.stderr)
        return 1

    counts: dict[str, int] = {}
    flagged: list[tuple[str, list[str], str]] = []
    for label, item in items:
        defects = find_quality_defects(item)
        if not defects:
            continue
        for defect in defects:
            counts[defect.code] = counts.get(defect.code, 0) + 1
        flagged.append((label, [d.code for d in defects], item.question.question))

    print(f"対象: {len(items)}設問")
    for code, count in sorted(counts.items()):
        print(f"  {code}: {count}件 ({count / len(items) * 100:.1f}%)")
    print(f"  いずれかに該当: {len(flagged)}設問")

    if args.list:
        print()
        for label, codes, question in flagged:
            print(f"--- {label} [{', '.join(codes)}]")
            print(f"    {question[:200]}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
