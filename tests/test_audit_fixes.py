"""Regression tests for the audit fixes (artefact integrity, validation, healthz).

Each test names the failure it pins down, because these were all silent
production bugs rather than crashes.
"""

import asyncio
import json

import pytest
from pydantic import ValidationError

import main


# ── a truncated encode must never be reported as ready ────────────────────

def test_clip_is_playable_rejects_empty_file(tmp_path):
    f = tmp_path / "empty.mp4"
    f.write_bytes(b"")
    assert main._clip_is_playable(f) is False


def test_clip_is_playable_rejects_truncated_mp4(tmp_path):
    """A killed encode leaves bytes but no moov atom: exists, unplayable."""
    f = tmp_path / "truncated.mp4"
    f.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 4096)
    assert main._clip_is_playable(f) is False


def test_finalize_clip_discards_a_failed_part(tmp_path, monkeypatch):
    part = tmp_path / "x.mp4.part"
    out = tmp_path / "x.mp4"
    part.write_bytes(b"partial")
    main.clip_jobs["x.mp4"] = {"progress": 0.5, "done": False, "error": None,
                              "started_at": 1.0}
    monkeypatch.setattr(main, "_clip_is_playable", lambda p: False)

    main._finalize_clip("x.mp4", part, out, rc=0, err_tail="")

    assert not part.exists(), "failed encode leaves a .part behind"
    assert not out.exists(), "unplayable output must not be promoted"
    assert main.clip_jobs["x.mp4"]["done"] is True
    assert main.clip_jobs["x.mp4"]["error"]


def test_finalize_clip_promotes_a_verified_part(tmp_path, monkeypatch):
    part = tmp_path / "y.mp4.part"
    out = tmp_path / "y.mp4"
    part.write_bytes(b"video bytes")
    main.clip_jobs["y.mp4"] = {"progress": 0.5, "done": False, "error": None,
                              "started_at": 1.0}
    monkeypatch.setattr(main, "_clip_is_playable", lambda p: True)

    main._finalize_clip("y.mp4", part, out, rc=0, err_tail="")

    assert out.exists() and not part.exists()
    assert main.clip_jobs["y.mp4"]["progress"] == 1.0
    assert main.clip_jobs["y.mp4"]["error"] is None


# ── request validation ────────────────────────────────────────────────────

def test_nan_range_is_rejected_by_the_model():
    """NaN passes `duration <= 0` and `duration < MIN` (both False)."""
    with pytest.raises(ValidationError):
        main.ClipRequest(media_id=1, start_sec=float("nan"), end_sec=10.0)


def test_negative_start_is_rejected_by_the_model():
    with pytest.raises(ValidationError):
        main.ClipRequest(media_id=1, start_sec=-5.0, end_sec=10.0)


@pytest.mark.parametrize("color", ["yellow:x", "a/../../evil", "white'; rm -rf /"])
def test_caption_colour_cannot_reach_the_filename(color):
    with pytest.raises(ValidationError):
        main.ClipRequest(media_id=1, start_sec=0, end_sec=5, caption_color=color)


def test_caption_position_and_format_are_enumerated():
    with pytest.raises(ValidationError):
        main.ClipRequest(media_id=1, start_sec=0, end_sec=5, caption_position="top")
    with pytest.raises(ValidationError):
        main.ClipRequest(media_id=1, start_sec=0, end_sec=5, format="exe")


def test_words_per_chunk_is_bounded():
    for bad in (0, -1, 999):
        with pytest.raises(ValidationError):
            main.ClipRequest(media_id=1, start_sec=0, end_sec=5, words_per_chunk=bad)


# ── quote search ─────────────────────────────────────────────────────────

def test_short_quote_query_does_not_scan(monkeypatch):
    """One-character queries matched everything and cost a full 1.2M-line scan."""
    called = {"n": 0}

    def boom(*a, **kw):
        called["n"] += 1
        raise AssertionError("search must not run for a 1-char query")

    monkeypatch.setattr(main, "_search_quote_index", boom)
    result = asyncio.run(main.search_quotes("e"))
    assert result["matches"] == []
    assert called["n"] == 0


# ── health probe ─────────────────────────────────────────────────────────

def test_healthz_reports_problems_not_a_bare_200(monkeypatch):
    monkeypatch.setattr(main, "_CACHE_FELL_BACK", True)
    resp = asyncio.run(main.healthz())
    body = json.loads(resp.body)
    assert resp.status_code == 503
    assert any("fell back" in p for p in body["problems"])


# ── clip filenames must be unique per film ────────────────────────────────

def test_non_latin_titles_no_longer_collide():
    """ASCII-only slugging mapped 東京物語 and 砂の女 to the same "unknown"."""
    a = main._clip_basename({"title": "東京物語", "type": "movie", "media_id": 1}, 10.0, 20.0)
    b = main._clip_basename({"title": "砂の女", "type": "movie", "media_id": 2}, 10.0, 20.0)
    assert a != b
    assert "unknown" not in a and "unknown" not in b


def test_same_title_and_year_are_separated_by_media_id():
    """The library really holds three "Mother" (2009) entries and duplicate copies."""
    a = main._clip_basename({"title": "Mother", "year": 2009, "media_id": 111}, 10.0, 20.0)
    b = main._clip_basename({"title": "Mother", "year": 2009, "media_id": 222}, 10.0, 20.0)
    assert a != b
    assert "2009" in a and "111" in a


def test_year_separates_same_titled_films():
    a = main._clip_basename({"title": "Mother", "year": 2009, "media_id": 1}, 10.0, 20.0)
    b = main._clip_basename({"title": "Mother", "year": 2017, "media_id": 2}, 10.0, 20.0)
    assert "2009" in a and "2017" in b and a != b
