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
