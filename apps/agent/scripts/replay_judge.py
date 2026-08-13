"""保存済み問題へ自己整合ジャッジを再実行するリプレイハーネス。

自己整合ジャッジのプロンプトは完成済みの QuizItem だけを読むため、新しい問題を
生成せずに判定結果を測り直せる。過去の生成結果や DynamoDB の scan 出力を入力にし、
プロンプト変更前に取得した基線との diff を取って偽陽性の変化を確認するために使う。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:

    def load_dotenv(*args: Any) -> bool:
        return False


# scripts/ から実行しても quiz_agent パッケージ(apps/agent直下)を解決できるようにする。
AGENT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENT_DIR))

from quiz_agent.judge import judge_self_consistency  # noqa: E402
from quiz_agent.schema import QuizItem  # noqa: E402


def _unmarshal_attribute(value: Any) -> Any:
    """DynamoDB の AttributeValue を Python の値へ再帰的に戻す。"""
    if not isinstance(value, dict) or len(value) != 1:
        raise ValueError("invalid DynamoDB attribute value")

    kind, raw = next(iter(value.items()))
    if kind == "S":
        return raw
    if kind == "L":
        return [_unmarshal_attribute(item) for item in raw]
    if kind == "M":
        return {key: _unmarshal_attribute(item) for key, item in raw.items()}
    if kind == "N":
        number = str(raw)
        try:
            return int(number)
        except ValueError:
            return float(number)
    if kind == "BOOL":
        return bool(raw)
    if kind == "NULL":
        return None
    raise ValueError(f"unsupported DynamoDB attribute type: {kind}")


def _unmarshal_item(raw_item: Any) -> dict[str, Any]:
    if not isinstance(raw_item, dict):
        raise ValueError("DynamoDB item must be an object")
    return {key: _unmarshal_attribute(value) for key, value in raw_item.items()}


def _item_id(value: Any, fallback: str) -> str:
    if value is None or value == "":
        return fallback
    return str(value)


def _load_jsonl(text: str, path: Path) -> list[tuple[str, QuizItem]]:
    loaded: list[tuple[str, QuizItem]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
            if not isinstance(record, dict) or "item" not in record:
                continue
            raw_item = record["item"]
            item = QuizItem.model_validate(raw_item)
            question_id = record.get("questionId")
            if question_id is None and isinstance(raw_item, dict):
                question_id = raw_item.get("questionId")
        except (json.JSONDecodeError, TypeError, ValueError):
            continue

        fallback = f"{path.name}:line-{line_number}"
        loaded.append((_item_id(question_id, fallback), item))
    return loaded


def _load_dynamodb_items(raw_items: Any, path: Path) -> list[tuple[str, QuizItem]]:
    if not isinstance(raw_items, list):
        return []

    loaded: list[tuple[str, QuizItem]] = []
    for index, raw_item in enumerate(raw_items, start=1):
        try:
            item = _unmarshal_item(raw_item)
            quiz_item = QuizItem.model_validate(
                {
                    "summary": item.get("summary", ""),
                    "question": {
                        "type": item["type"],
                        "question": item["question"],
                        "options": item["options"],
                        "correct": item["correct"],
                    },
                    "explanation": item["explanation"],
                }
            )
        except (TypeError, ValueError, KeyError):
            continue

        fallback = f"{path.name}:item-{index}"
        loaded.append((_item_id(item.get("questionId"), fallback), quiz_item))
    return loaded


def load_items(path: Path) -> list[tuple[str, QuizItem]]:
    """JSONL または DynamoDB scan の JSON から検証可能な問題だけを読む。"""
    text = path.read_text(encoding="utf-8")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        payload = None

    if isinstance(payload, dict) and "Items" in payload:
        return _load_dynamodb_items(payload["Items"], path)
    return _load_jsonl(text, path)


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    """判定結果のステータスと欠陥種別を集計する純粋関数。"""
    status_counts: dict[str, int] = {}
    defect_type_counts: dict[str, int] = {}
    for record in records:
        status = record.get("status")
        if status is not None:
            key = str(status)
            status_counts[key] = status_counts.get(key, 0) + 1
        defect_types = record.get("defect_types") or []
        if isinstance(defect_types, list):
            for defect_type in defect_types:
                key = str(defect_type)
                defect_type_counts[key] = defect_type_counts.get(key, 0) + 1

    return {
        "total": len(records),
        "status_counts": status_counts,
        "defect_type_counts": defect_type_counts,
    }


def diff_runs(
    before: list[dict[str, Any]], after: list[dict[str, Any]]
) -> dict[str, Any]:
    """2回の判定結果を ID で対応付け、判定または欠陥型の変化を返す。"""
    before_by_id = {record.get("id"): record for record in before}
    after_by_id = {record.get("id"): record for record in after}

    changed: list[dict[str, Any]] = []
    unchanged = 0
    for record in before:
        item_id = record.get("id")
        if item_id not in after_by_id:
            continue
        after_record = after_by_id[item_id]
        before_types = list(record.get("defect_types") or [])
        after_types = list(after_record.get("defect_types") or [])
        if (
            record.get("status") == after_record.get("status")
            and before_types == after_types
        ):
            unchanged += 1
            continue
        changed.append(
            {
                "id": item_id,
                "before": record.get("status"),
                "after": after_record.get("status"),
                "before_types": before_types,
                "after_types": after_types,
            }
        )

    return {
        "changed": changed,
        "unchanged": unchanged,
        "only_in_before": [
            record.get("id") for record in before if record.get("id") not in after_by_id
        ],
        "only_in_after": [
            record.get("id") for record in after if record.get("id") not in before_by_id
        ],
    }


def _load_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict) and record.get("id") is not None:
            records.append(record)
    return records


def run_replay(
    items: Sequence[tuple[str, Any]],
    judge_fn: Callable[[str, Any], dict[str, Any]],
    *,
    concurrency: int = 1,
    sleep: float = 0.0,
    on_record: Callable[[dict[str, Any]], None] | None = None,
) -> list[dict[str, Any]]:
    """全問を判定して結果を返す。

    1判定に60秒以上かかるため直列だと95問で100分を超える。OpenRouterは20 req/分
    なので、その範囲で並列化して待ち時間を削る。**1問の失敗で残りを捨てない**
    (無料枠での再実行は日次枠を食う)。
    """
    if concurrency <= 1:
        records: list[dict[str, Any]] = []
        for index, (item_id, item) in enumerate(items):
            record = _safe_judge(item_id, item, judge_fn)
            records.append(record)
            if on_record:
                on_record(record)
            if sleep and index < len(items) - 1:
                time.sleep(sleep)
        return records

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [
            pool.submit(_safe_judge, item_id, item, judge_fn) for item_id, item in items
        ]
        records = []
        for future in futures:
            record = future.result()
            records.append(record)
            if on_record:
                on_record(record)
    return records


def _safe_judge(
    item_id: str, item: Any, judge_fn: Callable[[str, Any], dict[str, Any]]
) -> dict[str, Any]:
    try:
        return judge_fn(item_id, item)
    except Exception as error:  # noqa: BLE001 - 1問分の失敗として記録して継続する
        return {
            "id": item_id,
            "status": "error",
            "defect_types": [],
            "detail": str(error),
            "model_id": None,
            "duration_sec": None,
        }


def _judge_item(item_id: str, item: QuizItem) -> dict[str, Any]:
    started = time.monotonic()
    try:
        result = judge_self_consistency(item)
        return {
            "id": item_id,
            "status": result.status,
            "defect_types": [defect.type for defect in result.defects],
            "detail": result.detail,
            "model_id": result.model_id,
            "duration_sec": time.monotonic() - started,
        }
    except Exception as error:  # noqa: BLE001 - 1問分の失敗として記録して継続する
        return {
            "id": item_id,
            "status": "error",
            "defect_types": [],
            "detail": str(error),
            "model_id": None,
            "duration_sec": time.monotonic() - started,
        }


def main() -> int:
    load_dotenv(AGENT_DIR / ".env")

    parser = argparse.ArgumentParser(
        description="保存済み問題へ自己整合ジャッジを再実行する"
    )
    parser.add_argument(
        "--in",
        dest="input_groups",
        action="append",
        nargs="+",
        type=Path,
        help="入力JSONLまたはDynamoDB scan JSON(複数指定可)",
    )
    parser.add_argument(
        "--out", type=Path, default=None, help="判定結果のJSONL出力パス"
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=3.0,
        help="各判定の間隔秒(既定3, 20 req/minに配慮)",
    )
    parser.add_argument("--limit", type=int, default=None, help="先頭N問だけ判定")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=1,
        help="並列数(既定1)。1判定60秒超・20 req/分のため8程度まで上げられる",
    )
    parser.add_argument(
        "--compare",
        nargs=2,
        type=Path,
        metavar=("BEFORE", "AFTER"),
        help="2つの判定結果JSONLを比較(指定時は判定しない)",
    )
    args = parser.parse_args()

    if args.compare:
        before_path, after_path = args.compare
        comparison = diff_runs(_load_records(before_path), _load_records(after_path))
        print(json.dumps(comparison, ensure_ascii=False, indent=2))
        return 0

    if not args.input_groups:
        parser.error("判定には --in が必要です")
    if args.out is None:
        parser.error("判定には --out が必要です")
    if args.limit is not None and args.limit < 0:
        parser.error("--limit は0以上で指定してください")

    input_paths = [path for group in args.input_groups for path in group]
    items = [item for path in input_paths for item in load_items(path)]
    if args.limit is not None:
        items = items[: args.limit]

    done = 0

    with args.out.open("w", encoding="utf-8") as out_fh:

        def write(record: dict[str, Any]) -> None:
            nonlocal done
            done += 1
            duration = record.get("duration_sec")
            elapsed = f"{duration:.1f}s" if isinstance(duration, (int, float)) else "-"
            print(
                f"[{done}/{len(items)}] id={record['id']} "
                f"status={record['status']} duration={elapsed}",
                file=sys.stderr,
            )
            out_fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            out_fh.flush()

        records = run_replay(
            items,
            _judge_item,
            concurrency=args.concurrency,
            sleep=args.sleep,
            on_record=write,
        )

    print(json.dumps(summarize(records), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
