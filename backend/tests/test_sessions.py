"""Cookie sessions: refresh token only in an httpOnly cookie, access token short-lived, logout revokes."""
import base64
import json

import pytest

from app.core.config import get_settings

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]

CSRF = {"X-Requested-With": "nullify"}
# bcrypt hash of "correct-horse-battery" produced by the old passlib-based code.
PASSLIB_HASH = "$2b$12$7CfVR6xQbJundbs0Jk8p/uazGM8K5WBBfqzZ8SU8D4N24mITbIe/2"


def claims(token):
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def refresh_cookie_header(response):
    [header] = [h for h in response.headers.get_list("set-cookie") if h.startswith("nullify_refresh=")]
    return header.lower()


async def login(client, user):
    r = await client.post("/api/auth/login", json={"username": user["username"], "password": user["password"]})
    assert r.status_code == 200, r.text
    return r


async def test_login_puts_refresh_token_only_in_httponly_cookie(client, make_user):
    """Regression for S-09: both tokens lived in localStorage, readable by any script."""
    r = await login(client, await make_user())

    assert "access_token" in r.json()
    assert "refresh_token" not in r.json()
    cookie = refresh_cookie_header(r)
    assert "httponly" in cookie
    assert "samesite=strict" in cookie
    assert "path=/api/auth" in cookie


async def test_refresh_cookie_is_secure_when_configured(client, make_user, monkeypatch):
    monkeypatch.setattr(get_settings(), "cookie_secure", True)
    r = await login(client, await make_user())
    assert "secure" in refresh_cookie_header(r)


async def test_access_token_lives_15_minutes(client, make_user):
    from app.core.config import Settings
    assert Settings.model_fields["jwt_access_token_expire_minutes"].default == 15  # shipped default

    token = (await login(client, await make_user())).json()["access_token"]
    c = claims(token)
    assert c["exp"] - c["iat"] == get_settings().jwt_access_token_expire_minutes * 60


async def test_refresh_issues_an_access_token_and_needs_csrf_header(client, make_user):
    await login(client, await make_user())

    assert (await client.post("/api/auth/refresh")).status_code == 403  # no X-Requested-With

    r = await client.post("/api/auth/refresh", headers=CSRF)
    assert r.status_code == 200
    new_access = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert (await client.get("/api/auth/me", headers=new_access)).status_code == 200

    client.cookies.clear()
    assert (await client.post("/api/auth/refresh", headers=CSRF)).status_code == 401


async def test_logout_clears_cookie_and_revokes_tokens(client, make_user):
    r = await login(client, await make_user())
    access = {"Authorization": f"Bearer {r.json()['access_token']}"}
    old_cookie = client.cookies.get("nullify_refresh")

    r = await client.post("/api/auth/logout", headers={**CSRF, **access})

    assert r.status_code == 204
    assert "max-age=0" in refresh_cookie_header(r) or "expires=thu, 01 jan 1970" in refresh_cookie_header(r)
    assert (await client.get("/api/auth/me", headers=access)).status_code == 401
    client.cookies.set("nullify_refresh", old_cookie, path="/api/auth")
    assert (await client.post("/api/auth/refresh", headers=CSRF)).status_code == 401


async def test_existing_passlib_password_hashes_still_work(client, make_user):
    user = await make_user(hashed_password=PASSLIB_HASH)
    await login(client, user)
