"""Invite-only accounts: admins create users and change roles; changes revoke old tokens."""
import logging

import pytest

from conftest import PASSWORD

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]

NEW = {"username": "new_sre", "email": "new.sre@example.com", "password": PASSWORD, "role": "sre"}
SECRET_FIELDS = {"api_key", "api_key_hash", "hashed_password", "token_version"}


async def login(client, username, password=PASSWORD):
    r = await client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}, r.json()["user"]


async def test_public_registration_is_gone(client):
    """Regression for S-01: anyone could register themselves as admin."""
    r = await client.post("/api/auth/register", json={**NEW, "role": "admin"})
    assert r.status_code == 404


async def test_admin_creates_user_without_exposing_secrets(client, make_headers):
    admin = await make_headers("admin")

    r = await client.post("/api/auth/users", json=NEW, headers=admin)

    assert r.status_code == 201
    assert r.json()["role"] == "sre"
    assert not SECRET_FIELDS & r.json().keys()


@pytest.mark.parametrize("role", ["sre", "viewer"])
async def test_only_admin_creates_users(client, make_headers, role):
    r = await client.post("/api/auth/users", json=NEW, headers=await make_headers(role))

    assert r.status_code == 403
    assert r.json()["detail"] == "Forbidden"  # S-20: no role names leaked


async def test_duplicate_username_or_email_is_400_not_500(client, make_headers):
    """Regression for B-16: a duplicate email hit the unique index and returned 500."""
    admin = await make_headers("admin")
    assert (await client.post("/api/auth/users", json=NEW, headers=admin)).status_code == 201

    same_name = await client.post("/api/auth/users", json={**NEW, "email": "other@example.com"}, headers=admin)
    same_email = await client.post("/api/auth/users", json={**NEW, "username": "other_sre"}, headers=admin)

    assert (same_name.status_code, same_email.status_code) == (400, 400)


@pytest.mark.parametrize("override", [
    {"password": "short"},
    {"email": "not-an-email"},
    {"username": "bad name!"},
    {"role": "superuser"},
])
async def test_weak_or_malformed_accounts_rejected(client, make_headers, override):
    r = await client.post("/api/auth/users", json={**NEW, **override}, headers=await make_headers("admin"))
    assert r.status_code == 422


async def test_role_change_revokes_existing_tokens(client, make_headers):
    """Regression for S-11: a demoted user kept their old privileges until the token expired."""
    admin = await make_headers("admin")
    await client.post("/api/auth/users", json=NEW, headers=admin)
    user_headers, user = await login(client, NEW["username"])
    assert (await client.get("/api/auth/me", headers=user_headers)).status_code == 200

    r = await client.patch(f"/api/auth/users/{user['id']}", json={"role": "viewer"}, headers=admin)

    assert r.status_code == 200
    assert r.json()["role"] == "viewer"
    assert (await client.get("/api/auth/me", headers=user_headers)).status_code == 401


async def test_deactivation_revokes_tokens_and_blocks_login(client, make_headers):
    admin = await make_headers("admin")
    await client.post("/api/auth/users", json=NEW, headers=admin)
    user_headers, user = await login(client, NEW["username"])

    await client.patch(f"/api/auth/users/{user['id']}", json={"is_active": False}, headers=admin)

    assert (await client.get("/api/auth/me", headers=user_headers)).status_code == 401
    r = await client.post("/api/auth/login", json={"username": NEW["username"], "password": PASSWORD})
    assert r.status_code in (401, 403)


@pytest.mark.parametrize("role", ["sre", "admin"])
async def test_assignee_list_is_public_fields_only(client, make_headers, role):
    """SREs assign incidents, so they need the list; it must never carry keys or emails."""
    r = await client.get("/api/auth/users", headers=await make_headers(role))

    assert r.status_code == 200
    assert r.json() and all(set(u) == {"id", "username", "role"} for u in r.json())


async def test_viewer_cannot_list_users(client, make_headers):
    assert (await client.get("/api/auth/users", headers=await make_headers("viewer"))).status_code == 403


async def test_cli_bootstraps_first_admin(client):
    from app.cli import create_user

    await create_user("root_admin", "root@example.com", PASSWORD, "admin")

    _, user = await login(client, "root_admin")
    assert user["role"] == "admin"


async def test_security_events_are_logged(client, make_headers, caplog):
    """S-21: failed logins, account and key changes leave an audit trail."""
    caplog.set_level(logging.INFO, logger="ims.security")
    admin = await make_headers("admin")

    await client.post("/api/auth/login", json={"username": "ghost", "password": "wrong-password-here"})
    await client.post("/api/auth/users", json=NEW, headers=admin)
    user_headers, user = await login(client, NEW["username"])
    await client.patch(f"/api/auth/users/{user['id']}", json={"role": "viewer"}, headers=admin)
    await client.post("/api/auth/api-key", headers=admin)

    events = " ".join(r.getMessage() for r in caplog.records if r.name == "ims.security")
    for event in ("login_failed", "user_created", "role_changed", "api_key_rotated"):
        assert event in events
