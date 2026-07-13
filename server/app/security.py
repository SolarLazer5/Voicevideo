# -*- coding: utf-8 -*-
"""Password hashing and JWT helpers."""

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
import jwt

from app.config import (
    JWT_ACCESS_TOKEN_EXPIRE_DAYS,
    JWT_ALGORITHM,
    JWT_SECRET_KEY,
)


def _password_digest(password: str) -> bytes:
    """Pre-hash password to guarantee it fits bcrypt's 72-byte limit."""
    return hashlib.sha256(password.encode("utf-8")).digest()


def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(_password_digest(password), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(
        _password_digest(plain_password), hashed_password.encode("utf-8")
    )


def create_access_token(
    data: dict[str, Any],
    expires_delta: timedelta | None = None,
) -> str:
    to_encode = data.copy()
    if expires_delta is None:
        expires_delta = timedelta(days=JWT_ACCESS_TOKEN_EXPIRE_DAYS)
    expire = datetime.now(timezone.utc) + expires_delta
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
