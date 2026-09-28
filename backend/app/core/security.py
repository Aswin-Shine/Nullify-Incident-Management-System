"""Auth primitives: JWTs (PyJWT), password hashing (bcrypt), API key generation and hashing.

Every token carries `tv` (the user's token_version); bumping it revokes all of that user's tokens.
Password hashing is CPU-bound: call it through `asyncio.to_thread` from request handlers.
"""
from __future__ import annotations
import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt

from app.core.config import get_settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())  # also verifies old passlib $2b$ hashes
    except ValueError:
        return False


def _encode(data: dict, token_type: str, lifetime: timedelta) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload = {**data, "type": token_type, "iat": now, "exp": now + lifetime, "jti": uuid.uuid4().hex}
    return jwt.encode(payload, settings.app_secret_key, algorithm=settings.jwt_algorithm)


def create_access_token(data: dict) -> str:
    """`data` must contain sub, role and tv."""
    return _encode(data, "access", timedelta(minutes=get_settings().jwt_access_token_expire_minutes))


def create_refresh_token(data: dict) -> str:
    return _encode(data, "refresh", timedelta(days=get_settings().jwt_refresh_token_expire_days))


def decode_token(token: str) -> Optional[dict]:
    settings = get_settings()
    try:
        return jwt.decode(token, settings.app_secret_key, algorithms=[settings.jwt_algorithm],
                          options={"require": ["exp", "iat", "sub", "type"]})
    except jwt.PyJWTError:
        return None


def generate_api_key() -> str:
    return secrets.token_urlsafe(32)


def hash_api_key(key: str) -> str:
    """API keys are high-entropy random strings, so a fast unsalted hash is enough to store them."""
    return hashlib.sha256(key.encode()).hexdigest()
