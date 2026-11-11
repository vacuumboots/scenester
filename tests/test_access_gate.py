"""Access gate and PIN-binding tests.

ACCESS_TOKEN is read once at import, deliberately (it is build/deploy config,
not a per-request knob). These tests therefore patch the module attribute
rather than the environment: mutating os.environ after import would assert
behaviour the running app does not have.
"""

import main
import pytest
from fastapi.testclient import TestClient

TOKEN = "correct-horse-battery-staple"


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def locked(monkeypatch):
    """Gate on, as it is on any deployment that is not localhost-only."""
    monkeypatch.setattr(main, "ACCESS_TOKEN", TOKEN)
    return TOKEN


# ── Gate off (the default) ─────────────────────────────────────────────────

def test_unconfigured_gate_leaves_the_api_open(client):
    assert main.ACCESS_TOKEN == ""
    assert client.get("/api/clips").status_code == 200
    body = client.get("/api/auth/status").json()
    assert body["locked"] is False
    assert body["access_token_required"] is False


# ── Gate on ────────────────────────────────────────────────────────────────

def test_api_refuses_an_uncredentialed_client(client, locked):
    r = client.get("/api/clips")
    assert r.status_code == 401
    assert r.json()["locked"] is True


def test_status_stays_answerable_so_the_ui_can_show_the_gate(client, locked):
    """The gate is useless if the app cannot discover that it is locked."""
    r = client.get("/api/auth/status")
    assert r.status_code == 200
    assert r.json()["locked"] is True
    assert r.json()["access_token_required"] is True


def test_health_probe_is_never_gated(client, locked):
    """/healthz is what docker and the uptime check poll; a 401 reads as down."""
    assert client.get("/healthz").status_code in (200, 503)


def test_wrong_token_is_rejected_without_issuing_a_cookie(client, locked):
    r = client.post("/api/auth/unlock", json={"token": "nope"})
    assert r.status_code == 401
    assert main._ACCESS_COOKIE not in r.cookies


def test_empty_token_is_rejected(client, locked):
    assert client.post("/api/auth/unlock", json={"token": ""}).status_code == 401


def test_right_token_issues_a_cookie_and_unlocks(client, locked):
    r = client.post("/api/auth/unlock", json={"token": TOKEN})
    assert r.status_code == 200
    assert r.json()["ok"] is True
    # The cookie must not be the secret itself: it is what a browser stores and
    # what survives in a backup.
    assert r.cookies[main._ACCESS_COOKIE] != TOKEN
    assert r.cookies[main._ACCESS_COOKIE] == main._access_cookie_value()
    assert client.get("/api/clips").status_code == 200


def test_header_is_accepted_for_scripts(client, locked):
    r = client.get("/api/clips", headers={"X-Scenester-Token": TOKEN})
    assert r.status_code == 200


def test_wrong_header_is_refused(client, locked):
    r = client.get("/api/clips", headers={"X-Scenester-Token": TOKEN + "x"})
    assert r.status_code == 401


def test_rotating_the_secret_invalidates_issued_cookies(client, locked, monkeypatch):
    client.post("/api/auth/unlock", json={"token": TOKEN})
    assert client.get("/api/clips").status_code == 200
    monkeypatch.setattr(main, "ACCESS_TOKEN", "a-new-secret")
    assert client.get("/api/clips").status_code == 401


# ── PIN flow is bound to the client that started it ────────────────────────

@pytest.fixture
def fake_plex(monkeypatch):
    """Stub plex.tv so the tests never leave the machine."""
    async def create_pin():
        return {"id": 4242, "code": "ABCD"}

    async def check_pin(pin_id):
        return {"status": "waiting"}

    monkeypatch.setattr(main.plex, "create_pin", create_pin)
    monkeypatch.setattr(main.plex, "check_pin", check_pin)


def test_pin_is_collected_only_by_the_client_that_started_it(fake_plex, monkeypatch):
    monkeypatch.setattr(main, "ACCESS_TOKEN", "")
    owner = TestClient(main.app)
    stranger = TestClient(main.app)

    assert owner.post("/api/auth/pin").json()["code"] == "ABCD"
    # The owner's own poll succeeds.
    assert owner.get("/api/auth/pin/4242").status_code == 200
    # A second client that never started a PIN cannot collect this one, even
    # though the id is a small integer and would be trivial to guess.
    assert stranger.get("/api/auth/pin/4242").status_code == 403


def test_unknown_pin_id_is_refused(fake_plex, monkeypatch):
    monkeypatch.setattr(main, "ACCESS_TOKEN", "")
    client = TestClient(main.app)
    assert client.get("/api/auth/pin/999999").status_code == 403


def test_a_forged_pin_cookie_is_refused(fake_plex, monkeypatch):
    monkeypatch.setattr(main, "ACCESS_TOKEN", "")
    owner = TestClient(main.app)
    owner.post("/api/auth/pin")
    forged = TestClient(main.app)
    forged.cookies.set(main._PIN_COOKIE, "4242.wrong-nonce")
    assert forged.get("/api/auth/pin/4242").status_code == 403


# ── Backwards compatibility with the cliparr-era names ─────────────────────

def test_env_prefers_scenester_prefix_and_still_reads_cliparr(monkeypatch):
    """The rename promised old env names keep working; nothing tested it."""
    monkeypatch.setenv("CLIPARR_FRAME_CONCURRENCY", "9")
    monkeypatch.setenv("SCENESTER_FRAME_CONCURRENCY", "3")
    assert main._env("FRAME_CONCURRENCY") == "3"

    monkeypatch.delenv("SCENESTER_FRAME_CONCURRENCY")
    assert main._env("FRAME_CONCURRENCY") == "9"

    monkeypatch.delenv("CLIPARR_FRAME_CONCURRENCY")
    assert main._env("FRAME_CONCURRENCY", "4") == "4"
