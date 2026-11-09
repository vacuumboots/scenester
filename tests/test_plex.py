"""Characterization tests for Scenester's pure Plex helpers in ``plex.py``.

``_translate_path`` and ``_find_subtitle_path`` are synchronous and pure (they
touch the filesystem only where a real path is passed). Tests lock in current
behavior — version preference, path translation, and subtitle discovery.
"""

import os

import plex


# ── _translate_path ────────────────────────────────────────────────────────


def test_translate_path_prefers_1080p_over_4k():
    mc = {
        "Media": [
            {"height": 2160, "Part": [{"file": "/data/media/movies/Film.4k.mkv"}]},
            {"height": 1080, "Part": [{"file": "/data/media/movies/Film.1080p.mkv"}]},
        ]
    }
    assert plex._translate_path(mc) == "/media/movies/Film.1080p.mkv"


def test_translate_path_falls_back_to_4k_only():
    mc = {"Media": [{"height": 2160, "Part": [{"file": "/data/media/movies/Film.mkv"}]}]}
    assert plex._translate_path(mc) == "/media/movies/Film.mkv"


def test_translate_path_returns_first_720_1080_candidate():
    # The loop returns the first Media whose height is in [720, 1080], in order.
    mc = {
        "Media": [
            {"height": 720, "Part": [{"file": "/data/media/a720.mkv"}]},
            {"height": 1080, "Part": [{"file": "/data/media/b1080.mkv"}]},
        ]
    }
    assert plex._translate_path(mc) == "/media/a720.mkv"


def test_translate_path_empty():
    assert plex._translate_path({}) == ""
    assert plex._translate_path({"Media": []}) == ""
    assert plex._translate_path({"Media": [{"height": 1080, "Part": [{}]}]}) == ""


def test_translate_path_replaces_prefix_once():
    mc = {"Media": [{"height": 1080, "Part": [{"file": "/data/media/x/Film.mkv"}]}]}
    assert plex._translate_path(mc) == "/media/x/Film.mkv"


# ── _find_subtitle_path ────────────────────────────────────────────────────


def test_find_subtitle_no_file(tmp_path):
    assert plex._find_subtitle_path(str(tmp_path / "missing.mkv")) is None


def test_find_subtitle_no_srt_present(tmp_path):
    media = tmp_path / "Movie.mkv"
    media.write_text("")
    assert plex._find_subtitle_path(str(media)) is None


def test_find_subtitle_prefers_english(tmp_path):
    media = tmp_path / "Movie.mkv"
    media.write_text("")
    (tmp_path / "Movie.srt").write_text("")
    english = tmp_path / "Movie.en.srt"
    english.write_text("")
    assert plex._find_subtitle_path(str(media)) == str(english)


def test_find_subtitle_dot_en_pattern(tmp_path):
    media = tmp_path / "Movie.mkv"
    media.write_text("")
    (tmp_path / "Movie.srt").write_text("")
    forced = tmp_path / "Movie.en.forced.srt"
    forced.write_text("")
    assert plex._find_subtitle_path(str(media)) == str(forced)


def test_find_subtitle_prefers_stem_match_when_no_english(tmp_path):
    media = tmp_path / "Movie.mkv"
    media.write_text("")
    (tmp_path / "Other.srt").write_text("")
    stem = tmp_path / "Movie.1080p.srt"
    stem.write_text("")
    assert plex._find_subtitle_path(str(media)) == str(stem)


def test_find_subtitle_falls_back_to_first_srt(tmp_path):
    media = tmp_path / "Movie.mkv"
    media.write_text("")
    only = tmp_path / "Whatever.srt"
    only.write_text("")
    assert plex._find_subtitle_path(str(media)) == str(only)


def test_find_subtitle_returns_none_on_listdir_error(tmp_path, monkeypatch):
    media = tmp_path / "Movie.mkv"
    media.write_text("")

    def boom(_):
        raise OSError("no dir")

    monkeypatch.setattr(os, "listdir", boom)
    assert plex._find_subtitle_path(str(media)) is None


def test_find_subtitle_never_borrows_another_files_english_srt(tmp_path):
    """Regression: English-anywhere-first picked a different film's subs when a
    directory held more than one SRT, burning the wrong dialogue on the clip."""
    media = tmp_path / "Film.mkv"
    media.write_text("")
    own = tmp_path / "Film.srt"
    own.write_text("1\n00:00:01,000 --> 00:00:02,000\nEnglish for Film\n")
    (tmp_path / "Other_Movie.en.srt").write_text(
        "1\n00:00:01,000 --> 00:00:02,000\nWrong movie's subs\n"
    )
    assert plex._find_subtitle_path(str(media)) == str(own)


def test_translate_path_configurable_prefix(monkeypatch):
    # Phase 5: PLEX_MEDIA_SRC / PLEX_MEDIA_DST override the hardcoded mapping.
    monkeypatch.setattr(plex, "PLEX_MEDIA_SRC", "/srv/plex")
    monkeypatch.setattr(plex, "PLEX_MEDIA_DST", "/videos")
    mc = {"Media": [{"height": 1080, "Part": [{"file": "/srv/plex/movies/Film.mkv"}]}]}
    assert plex._translate_path(mc) == "/videos/movies/Film.mkv"


def test_set_token_writes_0600_permissions(tmp_path, monkeypatch):
    # Phase 5: the persisted token is not world-readable.
    monkeypatch.setattr(plex, "_token", None)
    token_file = tmp_path / "plex_token.json"
    monkeypatch.setattr(plex, "TOKEN_FILE", token_file)
    plex.set_token("sekrit")
    assert token_file.stat().st_mode & 0o777 == 0o600
