"""Characterization tests for Scenester's pure backend helpers in ``main.py``.

These functions are synchronous and side-effect-free (``parse_srt`` only reads
a path passed to it). The tests lock in *current* behavior so future refactors
don't silently change clip naming, subtitle parsing, or the video MIME map.
"""

import main


# ── _video_mime ────────────────────────────────────────────────────────────


def test_video_mime_known_extensions():
    assert main._video_mime("/media/movies/Film.mkv") == "video/x-matroska"
    assert main._video_mime("/media/Film.m4v") == "video/mp4"
    assert main._video_mime("/media/Film.ts") == "video/mp2t"


def test_video_mime_unknown_falls_back_to_mp4():
    assert main._video_mime("/media/Film.xyz") == "video/mp4"


def test_video_mime_case_insensitive():
    assert main._video_mime("/media/Film.MKV") == "video/x-matroska"


# ── _slugify ───────────────────────────────────────────────────────────────


def test_slugify_basic():
    assert main._slugify("The Matrix") == "The_Matrix"


def test_slugify_collapses_separators():
    assert main._slugify("  Star   Wars---Ep. IV  ") == "Star_Wars_Ep_IV"


def test_slugify_strips_punctuation():
    assert main._slugify("Star Wars: Episode IV") == "Star_Wars_Episode_IV"


def test_slugify_empty_or_symbols_returns_unknown():
    assert main._slugify("") == "unknown"
    assert main._slugify("!!!@@@") == "unknown"


# ── _clip_basename ─────────────────────────────────────────────────────────


def test_clip_basename_movie():
    meta = {"title": "Inception"}
    assert main._clip_basename(meta, 5307.2, 5337.4) == "Inception_5307.2-5337.4"


def test_clip_basename_episode_with_show():
    meta = {
        "type": "episode",
        "title": "Pilot",
        "show_title": "Breaking Bad",
        "season": 1,
        "episode": 2,
    }
    assert (
        main._clip_basename(meta, 120.0, 150.0)
        == "Breaking_Bad_Pilot_S01E02_120.0-150.0"
    )


def test_clip_basename_episode_without_show_title():
    # Current behavior: an episode with no show_title gets the "unknown" slug
    # (because _slugify("") returns "unknown"). Characterized, not idealized.
    meta = {"type": "episode", "title": "Pilot", "season": 3, "episode": 7}
    assert main._clip_basename(meta, 1.5, 2.5) == "unknown_Pilot_S03E07_1.5-2.5"


def test_clip_basename_no_collision_on_subsecond_difference():
    # Same integer-second range, different sub-second → distinct filenames
    # (the Task 1.2 fix).
    a = main._clip_basename({"title": "Inception"}, 30.2, 40.4)
    b = main._clip_basename({"title": "Inception"}, 30.8, 40.4)
    assert a != b
    assert a == "Inception_30.2-40.4"
    assert b == "Inception_30.8-40.4"


def test_clip_basename_slugifies_title():
    meta = {"title": "The Matrix: Reloaded"}
    assert main._clip_basename(meta, 10.0, 20.0) == "The_Matrix_Reloaded_10.0-20.0"


# ── _srt_timestamp / _fmt_srt_timestamp ────────────────────────────────────


def test_srt_timestamp_converts_to_seconds():
    assert main._srt_timestamp("1", "2", "3", "456") == 3723.456


def test_fmt_srt_timestamp_formats():
    assert main._fmt_srt_timestamp(3723.456) == "01:02:03,456"
    assert main._fmt_srt_timestamp(0.0) == "00:00:00,000"


# ── parse_srt ──────────────────────────────────────────────────────────────


def test_parse_srt_comma_milliseconds(tmp_path):
    p = tmp_path / "comma.srt"
    p.write_text(
        "1\n00:00:01,000 --> 00:00:02,500\nHello world\n\n"
        "2\n00:00:03,000 --> 00:00:04,000\n<i>Second</i> line\n\n",
        encoding="utf-8",
    )
    entries = main.parse_srt(str(p))
    assert entries == [
        {"start": 1.0, "end": 2.5, "text": "Hello world"},
        {"start": 3.0, "end": 4.0, "text": "Second line"},  # HTML stripped
    ]


def test_parse_srt_period_milliseconds(tmp_path):
    p = tmp_path / "period.srt"
    p.write_text("1\n00:00:01.000 --> 00:00:02.500\nHello\n\n", encoding="utf-8")
    assert main.parse_srt(str(p)) == [
        {"start": 1.0, "end": 2.5, "text": "Hello"}
    ]


def test_parse_srt_multiline_text_collapsed(tmp_path):
    p = tmp_path / "multi.srt"
    p.write_text(
        "1\n00:00:01,000 --> 00:00:02,000\nLine one\nLine two\n\n", encoding="utf-8"
    )
    entries = main.parse_srt(str(p))
    assert entries[0]["text"] == "Line one Line two"


def test_parse_srt_latin1_fallback(tmp_path):
    p = tmp_path / "latin1.srt"
    p.write_bytes("1\n00:00:01,000 --> 00:00:02,000\ncaf\xe9\n\n".encode("latin-1"))
    entries = main.parse_srt(str(p))
    assert entries == [{"start": 1.0, "end": 2.0, "text": "café"}]


def test_parse_srt_missing_file_returns_empty():
    assert main.parse_srt("/nonexistent/definitely-not-here.srt") == []


# ── chunk_srt_for_social ───────────────────────────────────────────────────


def test_chunk_word_grouping_and_uppercase():
    out = main.chunk_srt_for_social(
        [{"start": 0.0, "end": 2.0, "text": "one two three four"}],
        words_per_chunk=2,
    )
    # 4 words / 2-per-chunk → 2 chunks, uppercased, evenly split over 2s.
    assert out == (
        "1\n00:00:00,000 --> 00:00:01,000\nONE TWO\n\n"
        "2\n00:00:01,000 --> 00:00:02,000\nTHREE FOUR\n"
    )


def test_chunk_min_display_time_floor():
    # Three single-word chunks over 1s: each would be 0.333s, but the 0.4s
    # readability floor widens the first to 0.4s and shifts the rest.
    out = main.chunk_srt_for_social(
        [{"start": 0.0, "end": 1.0, "text": "a b c"}], words_per_chunk=1
    )
    assert out == (
        "1\n00:00:00,000 --> 00:00:00,400\nA\n\n"
        "2\n00:00:00,333 --> 00:00:00,733\nB\n\n"
        "3\n00:00:00,600 --> 00:00:01,000\nC\n"
    )


def test_chunk_sorts_by_start_time():
    # Entries given out of order come back sorted by start time.
    out = main.chunk_srt_for_social(
        [
            {"start": 2.0, "end": 3.0, "text": "later words"},
            {"start": 0.0, "end": 1.0, "text": "first words"},
        ]
    )
    assert out == (
        "1\n00:00:00,000 --> 00:00:01,000\nFIRST WORDS\n\n"
        "2\n00:00:02,000 --> 00:00:03,000\nLATER WORDS\n"
    )


def test_chunk_skips_empty_entries():
    assert main.chunk_srt_for_social([{"start": 0.0, "end": 1.0, "text": "   "}]) == ""


# ── robustness (Phase 5): clip_jobs pruning + exception cage ───────────────


def test_prune_clip_jobs_removes_only_done_stale_entries():
    import time

    main.clip_jobs.clear()
    now = time.time()
    main.clip_jobs["old_done"] = {"progress": 1.0, "done": True, "started_at": now - 7200}
    main.clip_jobs["recent_done"] = {"progress": 1.0, "done": True, "started_at": now}
    main.clip_jobs["in_flight"] = {"progress": 0.5, "done": False, "started_at": now - 7200}
    main._prune_clip_jobs()
    assert "old_done" not in main.clip_jobs
    assert "recent_done" in main.clip_jobs
    assert "in_flight" in main.clip_jobs


def test_run_ffmpeg_clip_cages_unexpected_exception(monkeypatch):
    import asyncio

    async def boom(*args, **kwargs):
        raise RuntimeError("ffmpeg binary missing")

    monkeypatch.setattr(main, "_clip_impl", boom)
    main.clip_jobs.clear()
    asyncio.run(main._run_ffmpeg_clip("test_cage.mp4", "/nonexistent/input.mkv", 0.0, 1.0))
    job = main.clip_jobs["test_cage.mp4"]
    assert job["done"] is True
    assert job["error"] == "ffmpeg binary missing"
    assert job["progress"] == 0.0


# ── quote search: _search_quote_index ───────────────────────────────────────


def _sample_quote_index():
    return [
        {"media_id": 1, "title": "Inception", "year": 2010,
         "lines": [
             (10.0, 12.0, "You mustn't be afraid to dream a little bigger."),
             (20.0, 22.0, "What is the most resilient parasite?"),
         ]},
        {"media_id": 2, "title": "The Matrix", "year": 1999,
         "lines": [
             (5.0, 8.0, "Wake up, Neo."),
             (9.0, 12.0, "There is no spoon."),
         ]},
    ]


def test_quote_search_finds_word():
    matches = main._search_quote_index(_sample_quote_index(), "resilient")
    assert len(matches) == 1
    assert matches[0]["media_id"] == 1
    assert matches[0]["title"] == "Inception"
    assert matches[0]["year"] == 2010
    assert matches[0]["start"] == 20.0
    assert matches[0]["end"] == 22.0
    assert matches[0]["text"] == "What is the most resilient parasite?"


def test_quote_search_case_insensitive():
    matches = main._search_quote_index(_sample_quote_index(), "WAKE UP")
    assert len(matches) == 1
    assert matches[0]["media_id"] == 2


def test_quote_search_spans_movies():
    matches = main._search_quote_index(_sample_quote_index(), "is")
    assert len(matches) == 2
    assert {m["media_id"] for m in matches} == {1, 2}


def test_quote_search_word_boundaries():
    idx = [{"media_id": 1, "title": "T", "year": 0, "lines": [
        (0.0, 1.0, "Any indications of abuse?"),
        (1.0, 2.0, "The cat sat."),
        (2.0, 3.0, "Scared of the dark."),
    ]}]
    # "cat" as a word matches "The cat sat." — and never "indications"
    cat = main._search_quote_index(idx, "cat")
    assert len(cat) == 1
    assert cat[0]["text"] == "The cat sat."
    # "red" must not match inside "Scared"
    assert main._search_quote_index(idx, "red") == []


def test_quote_search_phrase_keeps_adjacency():
    idx = [{"media_id": 1, "title": "T", "year": 0, "lines": [
        (0.0, 2.0, "Let's do it again."),
        (2.0, 4.0, "Do you think it will happen again?"),
    ]}]
    hits = main._search_quote_index(idx, "do it again")
    assert len(hits) == 1
    assert hits[0]["text"] == "Let's do it again."


def test_quote_search_limits_per_movie():
    idx = [
        {"media_id": 1, "title": "A", "year": 0,
         "lines": [(float(i), float(i + 1), "the word") for i in range(5)]},
        {"media_id": 2, "title": "B", "year": 0,
         "lines": [(float(i), float(i + 1), "the word") for i in range(5)]},
    ]
    matches = main._search_quote_index(idx, "word", cap=50, per_movie=3)
    assert len(matches) == 6          # 3 from each movie, not 10
    assert [m["media_id"] for m in matches] == [1, 1, 1, 2, 2, 2]


def test_quote_search_empty_query_returns_nothing():
    assert main._search_quote_index(_sample_quote_index(), "") == []
    assert main._search_quote_index(_sample_quote_index(), "   ") == []


def test_quote_search_no_match():
    assert main._search_quote_index(_sample_quote_index(), "zzzz") == []


def test_quote_search_caps_at_limit():
    index = [
        {"media_id": i, "title": "T", "year": 0,
         "lines": [(0.0, 1.0, "the quick brown fox")]}
        for i in range(10)
    ]
    matches = main._search_quote_index(index, "the", cap=3)
    assert len(matches) == 3


def test_quote_search_returns_all_when_under_cap():
    index = [
        {"media_id": i, "title": "T", "year": 0,
         "lines": [(0.0, 1.0, "the word")]}
        for i in range(10)
    ]
    matches = main._search_quote_index(index, "word")
    assert len(matches) == 10


def test_quote_search_escapes_regex_specials():
    idx = [{"media_id": 1, "title": "T", "year": 0, "lines": [
        (0.0, 1.0, "a+b is the answer"),
        (1.0, 2.0, "8 1/2 is a film"),
    ]}]
    assert len(main._search_quote_index(idx, "a+b")) == 1
    assert len(main._search_quote_index(idx, "8 1/2")) == 1
