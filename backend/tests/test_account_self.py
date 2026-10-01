"""Change my own password: bearer-authenticated, re-verifies the current password, signs out other sessions."""
import logging
from unittest.mock import patch

import pytest

from app.core.config import get_settings
from conftest import PASSWORD

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]

CSRF = {"X-Requested-With": "nullify"}
NEW_PASSWORD = "a-brand-new-passphrase"


async def login(client, user, password=PASSWORD):
    return await client.post("/api/auth/login", json={"username": user["username"], "password": password})


def bearer(r):
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def change(client, headers, current=PASSWORD, new=NEW_PASSWORD):
    return client.post("/api/auth/password", json={"current_password": current, "new_password": new}, headers=headers)


async def test_change_password_signs_out_other_sessions_and_keeps_this_one(client, make_user):
    user = await make_user()
    first = await login(client, user)
    old_headers = bearer(first)
    old_cookie = client.cookies.get("nullify_refresh")
    client.cookies.clear()
    second = await login(client, user)  # the session that must survive the change

    r = await change(client, bearer(second))

    assert r.status_code == 200
    assert r.json()["access_token"] and r.json()["user"]["username"] == user["username"]
    assert "nullify_refresh=" in " ".join(r.headers.get_list("set-cookie"))
    assert (await client.get("/api/auth/me", headers=old_headers)).status_code == 401
    assert (await client.get("/api/auth/me", headers=bearer(r))).status_code == 200
    client.cookies.set("nullify_refresh", old_cookie, path="/api/auth")
    assert (await client.post("/api/auth/refresh", headers=CSRF)).status_code == 401
    assert (await login(client, user, NEW_PASSWORD)).status_code == 200
    assert (await login(client, user)).status_code == 401


async def test_wrong_current_password_is_400_and_changes_nothing(client, make_user):
    """400, not 401: a 401 would make the frontend try a session refresh."""
    user = await make_user()
    headers = bearer(await login(client, user))

    r = await change(client, headers, current="not-the-password")

    assert r.status_code == 400
    assert (await login(client, user)).status_code == 200


async def test_new_password_must_be_long_enough_and_different(client, make_user):
    user = await make_user()
    headers = bearer(await login(client, user))

    assert (await change(client, headers, new="short")).status_code == 422
    assert (await change(client, headers, new=PASSWORD)).status_code == 400


async def test_change_password_needs_a_token(client):
    r = await client.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": NEW_PASSWORD})
    assert r.status_code == 401


async def test_change_password_is_rate_limited(client, make_user, monkeypatch):
    """Per-IP auth budget (shared with login), so the current password cannot be brute-forced."""
    monkeypatch.setattr(get_settings(), "rate_limit_auth_per_min", 3)
    user = await make_user()

    with patch("app.core.rate_limit._now", return_value=2_000_000.2):  # one fixed window
        headers = bearer(await login(client, user))  # budget call 1
        codes = [(await change(client, headers, current="wrong-password-xx")).status_code for _ in range(3)]

    assert codes == [400, 400, 429]


async def test_password_change_is_logged(client, make_user, caplog):
    caplog.set_level(logging.INFO, logger="ims.security")
    user = await make_user()
    await change(client, bearer(await login(client, user)))

    assert any(r.name == "ims.security" and "password_changed" in r.getMessage() and user["username"] in r.getMessage()
               for r in caplog.records)
