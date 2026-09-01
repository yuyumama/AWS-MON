"""Python 側の資格表が packages/shared/src/certs.ts と一致することを検証する。

資格の定義の正は certs.ts にある。Python 側(quiz_agent/certs.py)はその写しで、
cli.py と scripts/sample_generations.py が API を介さず generate_quiz を直接
呼ぶために必要になっている。写しである以上ドリフトするので、CIで落とす。

certs.ts をパースするのは、TS をビルドして読むより依存が軽く、片方だけ直したときに
確実に落ちるため。フィールドの並び(code -> fullName -> level)に依存している。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from quiz_agent.certs import (
    CERT_FULL_NAMES,
    CERT_LEVELS,
    DIFFICULTY_TIERS,
)

_CERTS_TS = (
    Path(__file__).resolve().parents[3] / "packages" / "shared" / "src" / "certs.ts"
)

_ENTRY = re.compile(
    r'code:\s*"(?P<code>[a-z]+)",'
    r".*?"
    r'fullName:\s*"(?P<full_name>[^"]+)",'
    r".*?"
    r'level:\s*"(?P<level>[A-Za-z]+)",',
    re.DOTALL,
)


def _parse_certs_ts() -> dict[str, tuple[str, str]]:
    """certs.ts から 資格コード -> (正式名称, レベル) を取り出す。"""
    source = _CERTS_TS.read_text(encoding="utf-8")
    parsed = {
        m.group("code"): (m.group("full_name"), m.group("level"))
        for m in _ENTRY.finditer(source)
    }
    assert parsed, f"certs.ts から資格定義を1件も取り出せなかった: {_CERTS_TS}"
    return parsed


def test_certs_ts_is_readable() -> None:
    assert _CERTS_TS.is_file(), f"certs.ts が見つからない: {_CERTS_TS}"


def test_cert_codes_match() -> None:
    ts_codes = set(_parse_certs_ts())
    assert set(CERT_LEVELS) == ts_codes
    assert set(CERT_FULL_NAMES) == ts_codes


@pytest.mark.parametrize("code", sorted(_parse_certs_ts()))
def test_level_and_full_name_match(code: str) -> None:
    full_name, level = _parse_certs_ts()[code]
    assert CERT_LEVELS[code] == level, (
        f"{code} のレベルが certs.ts と食い違っている: "
        f"python={CERT_LEVELS[code]} ts={level}"
    )
    assert CERT_FULL_NAMES[code] == full_name, (
        f"{code} の正式名称が certs.ts と食い違っている: "
        f"python={CERT_FULL_NAMES[code]} ts={full_name}"
    )


def test_every_level_has_a_difficulty_tier() -> None:
    """certs.ts に新しい CertLevel が増えたら、難易度仕様の割り当てを強制する。"""
    levels = {level for _, level in _parse_certs_ts().values()}
    missing = levels - set(DIFFICULTY_TIERS)
    assert not missing, f"難易度区分が割り当てられていないレベル: {sorted(missing)}"


def test_explicit_tier_overrides_cert_level() -> None:
    """API が解決した難易度が資格レベルより優先されること。"""
    from quiz_agent.prompts import build_quiz_prompt

    # SAA は既定なら associate だが、HARD 指定なら professional の文面になる。
    standard = build_quiz_prompt("saa")
    harder = build_quiz_prompt("saa", difficulty_tier="professional")
    assert "アソシエイト級" in standard
    assert "プロフェッショナル級" in harder


def test_unknown_tier_is_rejected() -> None:
    """未知の区分名は黙って既定に落とさない(プロンプトが静かに別物になるのを防ぐ)。"""
    from quiz_agent.prompts import resolve_difficulty_tier

    with pytest.raises(ValueError, match="不明な難易度区分"):
        resolve_difficulty_tier("saa", "expert")


def test_research_prompt_follows_explicit_tier() -> None:
    """調査プロンプトの回数指示も明示指定に従うこと。"""
    from quiz_agent.prompts import build_docs_research_prompt, build_quiz_prompt

    prompt = build_docs_research_prompt(build_quiz_prompt("saa"), "saa", "foundational")
    assert "search_documentation は最大1回" in prompt
