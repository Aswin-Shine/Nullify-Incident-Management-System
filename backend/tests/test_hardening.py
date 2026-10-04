"""Hardening: secret strength, no public docs in production, input limits, auth on analytics, CORS."""
import os

import pytest
from pydantic import ValidationError

from app.core.config import Settings, get_settings
from app.db.nosql import _path
from app.main import docs_kwargs
from app.services.ingestion import process_signal

DEFAULT_SECRET = "CHANGE_ME_IN_PRODUCTION_USE_LONG_RANDOM_STRING"
STRONG_SECRET = "s" * 40
db_test = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]


@pytest.mark.parametrize("secret", [DEFAULT_SECRET, "too-short"])
def test_production_refuses_weak_secret(secret):
    """Regression for S-02: production booted with a publicly known JWT secret."""
    with pytest.raises(ValidationError):
        Settings(app_env="production", app_secret_key=secret)


def test_production_accepts_strong_secret_and_dev_keeps_default():
    Settings(app_env="production", app_secret_key=STRONG_SECRET)
    Settings(app_env="development", app_secret_key=DEFAULT_SECRET)


def test_settings_read_root_env_from_any_working_directory():
    """One env file at the repo root (also what docker compose reads), found by absolute path,
    so alembic/CLI/tests don't depend on cwd."""
    env_file = Settings.model_config["env_file"]
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    assert os.path.isabs(env_file)
    assert env_file == os.path.join(repo_root, ".env")


def test_api_docs_are_off_in_production():
    """S-13: /docs and /openapi.json mapped the whole API for anyone."""
    assert docs_kwargs(Settings(app_env="production", app_secret_key=STRONG_SECRET)) == \
        {"docs_url": None, "redoc_url": None, "openapi_url": None}
    assert docs_kwargs(Settings(app_env="development"))["docs_url"] == "/docs"


def test_lake_filenames_are_allowlisted():
    """S-18: only `/` and `:` were stripped from component ids used as file names."""
    path = _path("../..\\etc/passwd:x")
    assert os.path.dirname(path) == get_settings().lake_dir
    assert set(os.path.basename(path)) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-jsonl")


@db_test[0]
@db_test[1]
async def test_timeseries_requires_auth(client):
    """S-16: signal volumes per component were readable without logging in."""
    assert (await client.get("/api/timeseries")).status_code == 401


@db_test[0]
@db_test[1]
async def test_assigning_unknown_user_is_422_not_500(client, make_headers):
    """S-17: an unknown assignee hit the foreign key at commit and returned 500."""
    headers = await make_headers("sre")
    wi_id = await process_signal({"component_id": "CACHE_ASSIGN", "signal_type": "ERROR", "message": "x"})

    r = await client.patch(f"/api/work-items/{wi_id}/assign", json={"assignee_id": "no-such-user"}, headers=headers)

    assert r.status_code == 422


@db_test[0]
@db_test[1]
@pytest.mark.parametrize("role,active", [("viewer", True), ("sre", False)])
async def test_assignee_must_be_an_active_sre_or_admin(client, make_headers, make_user, role, active):
    """B-35: the API accepted viewers and deactivated accounts; only the UI hid them."""
    from sqlalchemy import update
    from app.db.postgres import AsyncSessionLocal, User

    headers = await make_headers("sre")
    target = await make_user(role)
    async with AsyncSessionLocal() as db:
        await db.execute(update(User).where(User.id == target["id"]).values(is_active=active))
        await db.commit()
    wi_id = await process_signal({"component_id": "CACHE_ASSIGN", "signal_type": "ERROR", "message": "x"})

    r = await client.patch(f"/api/work-items/{wi_id}/assign", json={"assignee_id": target["id"]}, headers=headers)

    assert r.status_code == 422
    assert "active SRE or admin" in r.json()["detail"]


@db_test[0]
@db_test[1]
@pytest.mark.parametrize("limit", [-1, 0, 100000])
async def test_timeseries_limit_is_bounded(client, make_headers, limit):
    """B-36: limit=-1 reached Postgres as LIMIT -1 and came back as a 500."""
    r = await client.get("/api/timeseries", params={"limit": limit}, headers=await make_headers("sre"))
    assert r.status_code == 422


@db_test[0]
@db_test[1]
@pytest.mark.parametrize("override", [
    {"component_id": "../../etc/passwd"},
    {"component_id": "A" * 65},
    {"message": "x" * 4097},
    {"signal_type": "T" * 65},
    {"metadata": {"blob": "x" * 9000}},
])
async def test_signal_payload_limits(client, make_headers, override):
    """S-19: unbounded fields let one producer fill disk and memory."""
    sig = {"component_id": "CACHE_OK", "signal_type": "ERROR", "message": "fine", **override}
    r = await client.post("/api/signals", json=sig, headers=await make_headers("sre"))
    assert r.status_code == 422


@db_test[0]
@db_test[1]
async def test_cors_allows_only_configured_origins(client):
    """S-22: CORS origins were hardcoded instead of configured."""
    allowed = get_settings().allowed_origins[0]
    ok = await client.get("/health/live", headers={"Origin": allowed})
    evil = await client.get("/health/live", headers={"Origin": "https://evil.example"})

    assert ok.headers.get("access-control-allow-origin") == allowed
    assert "access-control-allow-origin" not in evil.headers


def test_db_pool_fits_under_postgres_max_connections_across_workers():
    """B-19: 30 connections per process x 4 uvicorn workers exceeded Postgres's default 100."""
    from app.db.postgres import engine

    s = Settings()
    assert (s.db_pool_size, s.db_max_overflow) == (5, 5)
    assert (engine.pool.size(), engine.pool._max_overflow) == (s.db_pool_size, s.db_max_overflow)
    assert 4 * (s.db_pool_size + s.db_max_overflow) < 100


@pytest.mark.asyncio
async def test_lake_writes_for_different_components_do_not_block_each_other():
    """B-15: one global lock serialised every lake append."""
    import asyncio
    from app.db import nosql

    sig = lambda c: {"component_id": c, "signal_type": "ERROR", "message": "x"}  # noqa: E731
    async with nosql._locks[nosql._path("LAKE_A")]:
        await asyncio.wait_for(nosql.append_signal(sig("LAKE_B")), 1)  # B is not blocked by A's lock

        same = asyncio.create_task(nosql.append_signal(sig("LAKE_A")))
        await asyncio.sleep(0.1)
        assert not same.done()  # the same component still serialises
    await asyncio.wait_for(same, 1)


def test_throughput_line_is_silent_when_idle_and_names_the_process():
    """B-22: the per-process log printed a zero line every 5 s and did not say which worker it was."""
    from app.services.ingestion import _throughput_line

    assert _throughput_line(0, 5.0, 0, 50_000) is None
    line = _throughput_line(100, 5.0, 3, 50_000)
    assert f"pid={os.getpid()}" in line
    assert "20.0 sig/sec" in line
    assert _throughput_line(0, 5.0, 7, 50_000) is not None  # idle workers with a backlog still report


@db_test[0]
@db_test[1]
@pytest.mark.parametrize("length,status", [(4000, 201), (4001, 422)])
async def test_comment_body_is_bounded(client, make_headers, length, status):
    """Harden: a comment body had no upper bound, so one request could store megabytes."""
    headers = await make_headers("sre")
    wi_id = await process_signal({"component_id": "CACHE_BOUND", "signal_type": "ERROR", "message": "x"})
    r = await client.post(f"/api/work-items/{wi_id}/comments", json={"body": "x" * length}, headers=headers)
    assert r.status_code == status


@db_test[0]
@db_test[1]
@pytest.mark.parametrize("field", ["fix_applied", "prevention_steps"])
async def test_rca_free_text_is_bounded(client, make_headers, field):
    """Harden: RCA free text had no upper bound."""
    headers = await make_headers("sre")
    wi_id = await process_signal({"component_id": "CACHE_BOUND", "signal_type": "ERROR", "message": "x"})
    rca = {
        "incident_start": "2026-01-01T10:00:00Z", "incident_end": "2026-01-01T12:00:00Z",
        "root_cause_category": "Infrastructure Failure", "fix_applied": "ok", "prevention_steps": "ok",
    }
    r = await client.post(f"/api/work-items/{wi_id}/rca", json={**rca, field: "x" * 8001}, headers=headers)
    assert r.status_code == 422
    assert "8000" in r.text
