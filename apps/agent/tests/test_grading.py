from __future__ import annotations

import pytest

from quiz_agent.grading import arrays_equal

# 複数選択の正誤判定。12行だが、誤ると採点結果がそのまま利用者に見える。


@pytest.mark.parametrize(
    ("a", "b"),
    [
        pytest.param([], [], id="どちらも空"),
        pytest.param(["A"], ["A"], id="単一で一致"),
        pytest.param(["A", "B"], ["A", "B"], id="同順で一致"),
        pytest.param(["B", "A"], ["A", "B"], id="順不同で一致"),
        pytest.param(["C", "A", "B"], ["B", "C", "A"], id="3つの順不同"),
    ],
)
def test_equal(a: list[str], b: list[str]) -> None:
    assert arrays_equal(a, b) is True


@pytest.mark.parametrize(
    ("a", "b"),
    [
        pytest.param(["A"], ["B"], id="別のラベル"),
        pytest.param(["A"], ["A", "B"], id="片方が不足"),
        pytest.param(["A", "B"], ["A"], id="片方が過剰"),
        pytest.param([], ["A"], id="空と非空"),
        pytest.param(["a"], ["A"], id="大文字小文字は区別する"),
        pytest.param(["A", "A"], ["A", "B"], id="重複と別ラベル"),
    ],
)
def test_not_equal(a: list[str], b: list[str]) -> None:
    assert arrays_equal(a, b) is False


def test_duplicates_are_not_collapsed() -> None:
    # 集合ではなく多重集合として比較する。["A","A"] と ["A"] は別物。
    assert arrays_equal(["A", "A"], ["A"]) is False
    assert arrays_equal(["A", "A"], ["A", "A"]) is True


def test_does_not_mutate_inputs() -> None:
    a = ["B", "A"]
    b = ["A", "B"]

    arrays_equal(a, b)

    assert a == ["B", "A"]
    assert b == ["A", "B"]
