# -*- coding: utf-8 -*-
"""Authentication endpoints."""

import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.activation import normalize_code_input
from app.db import SessionLocal
from app.models import ActivationCode, User
from app.security import (
    create_access_token,
    decode_access_token,
    get_password_hash,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _normalize_username(username: str) -> str:
    return username.strip().lower()


def _as_utc(dt: datetime) -> datetime:
    """Ensure a datetime is timezone-aware in UTC."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _check_activation_expired(user: User, db: Session) -> bool:
    """Return True and reset flag if the user's activation has expired."""
    if not user.is_activated:
        return True
    if user.activation_expires_at and _as_utc(user.activation_expires_at) < datetime.now(
        timezone.utc
    ):
        user.is_activated = False
        db.commit()
        return True
    return False


class RegisterRequest(BaseModel):
    username: str = Field(
        ...,
        min_length=3,
        max_length=32,
        pattern=r"^[a-zA-Z0-9_]+$",
    )
    password: str = Field(..., min_length=6, max_length=128)


class LoginRequest(BaseModel):
    username: str = Field(
        ...,
        min_length=3,
        max_length=32,
        pattern=r"^[a-zA-Z0-9_]+$",
    )
    password: str = Field(..., min_length=1, max_length=128)


class ActivateRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=64)


class UserOut(BaseModel):
    id: int
    username: str
    is_activated: bool
    activated_at: str | None
    activation_expires_at: str | None
    created_at: str


class AuthResponse(BaseModel):
    access_token: str
    token_type: str
    user: UserOut


def _user_dict(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "is_activated": user.is_activated,
        "activated_at": user.activated_at.isoformat() if user.activated_at else None,
        "activation_expires_at": user.activation_expires_at.isoformat()
        if user.activation_expires_at
        else None,
        "created_at": user.created_at.isoformat() if user.created_at else "",
    }


def _issue_token(user: User) -> str:
    return create_access_token(
        {
            "sub": str(user.id),
            "username": user.username,
            "is_activated": user.is_activated,
        }
    )


def _get_current_user(authorization: str | None, db: Session) -> User:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="缺少认证头",
        )

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="认证头格式无效",
        )

    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="令牌无效或已过期",
        )

    user = db.query(User).filter(User.id == int(payload.get("sub", 0))).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户不存在",
        )
    return user


@router.post("/register", response_model=AuthResponse)
def register(req: RegisterRequest, db: Session = Depends(get_db)) -> dict:
    username = _normalize_username(req.username)
    if not re.match(r"^[a-z0-9_]+$", username):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username must contain only lowercase letters, numbers, and underscores",
        )

    existing = db.query(User).filter(User.username == username).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="用户名已存在",
        )

    user = User(
        username=username,
        password_hash=get_password_hash(req.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    return {
        "access_token": _issue_token(user),
        "token_type": "bearer",
        "user": _user_dict(user),
    }


@router.post("/login", response_model=AuthResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)) -> dict:
    username = _normalize_username(req.username)
    user = db.query(User).filter(User.username == username).first()
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误",
        )

    _check_activation_expired(user, db)

    return {
        "access_token": _issue_token(user),
        "token_type": "bearer",
        "user": _user_dict(user),
    }


@router.post("/activate", response_model=AuthResponse)
def activate(
    req: ActivateRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    user = _get_current_user(authorization, db)

    code_text = normalize_code_input(req.code)
    if not code_text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="激活码格式不正确",
        )

    code = db.query(ActivationCode).filter(ActivationCode.code == code_text).first()
    if not code or not code.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="激活码无效或已被禁用",
        )

    if code.expires_at and _as_utc(code.expires_at) < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="激活码已过期",
        )

    if code.used_count >= code.max_uses:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="激活码已被使用完毕",
        )

    now = datetime.now(timezone.utc)
    code.used_count += 1
    user.is_activated = True
    user.activation_code_id = code.id
    user.activated_at = now
    if code.code_type == "trial" and code.trial_days:
        user.activation_expires_at = now + timedelta(days=code.trial_days)
    else:
        user.activation_expires_at = None

    db.commit()
    db.refresh(user)

    return {
        "access_token": _issue_token(user),
        "token_type": "bearer",
        "user": _user_dict(user),
    }


@router.get("/me", response_model=UserOut)
def me(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    user = _get_current_user(authorization, db)
    _check_activation_expired(user, db)
    return _user_dict(user)
