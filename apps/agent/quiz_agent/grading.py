"""正誤判定ユーティリティ。

構造化出力に移行したため、JSONパース・正規化は不要になった。
複数選択の順不同比較だけここに残す（後でフロント/採点に使う）。
"""


def arrays_equal(a: list[str], b: list[str]) -> bool:
    """順不同で2つのラベル配列が等しいか（複数選択の正誤判定用）。"""
    if len(a) != len(b):
        return False
    return sorted(a) == sorted(b)
