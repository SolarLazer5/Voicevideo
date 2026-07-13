# -*- coding: utf-8 -*-
"""Admin endpoints for activation code management."""

from datetime import datetime, timezone
from typing import Optional


def _as_utc(dt: datetime) -> datetime:
    """Ensure a datetime is timezone-aware in UTC."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from app.activation import generate_activation_codes
from app.config import ADMIN_SECRET_KEY
from app.db import SessionLocal
from app.models import ActivationCode, User

router = APIRouter(prefix="/api/admin", tags=["admin"])


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _verify_admin_key(admin_key: str | None) -> None:
    if not admin_key or admin_key != ADMIN_SECRET_KEY:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="管理密钥错误",
        )


class GenerateCodesRequest(BaseModel):
    count: int = Field(..., ge=1, le=1000)
    code_type: str = Field(..., pattern=r"^(permanent|trial)$")
    trial_days: Optional[int] = Field(None, ge=1, le=365)
    remark: Optional[str] = Field(None, max_length=128)


@router.post("/codes")
def admin_generate_codes(
    req: GenerateCodesRequest,
    admin_key: str | None = Header(default=None, alias="X-Admin-Key"),
    db: Session = Depends(get_db),
) -> dict:
    _verify_admin_key(admin_key)

    if req.code_type == "trial" and not req.trial_days:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="试用码必须填写 trial_days",
        )

    codes = generate_activation_codes(
        db,
        count=req.count,
        code_type=req.code_type,
        trial_days=req.trial_days,
        remark=req.remark,
    )
    return {
        "count": len(codes),
        "codes": codes,
        "code_type": req.code_type,
        "trial_days": req.trial_days,
        "remark": req.remark,
    }


def _compute_remaining_days(code: ActivationCode) -> tuple[Optional[int], str]:
    """Return (remaining_days, remaining_label) for an activation code."""
    if code.used_count < code.max_uses:
        return None, "未激活"

    user = code.activated_user
    if not user:
        return None, "未激活"

    if code.code_type == "trial" and user.activation_expires_at:
        now = datetime.now(timezone.utc)
        delta = _as_utc(user.activation_expires_at) - now
        days = max(0, int(delta.total_seconds() // 86400))
        if days <= 0:
            return 0, "已过期"
        return days, f"{days} 天后到期"

    return None, "永久"


@router.get("/codes")
def admin_list_codes(
    admin_key: str | None = Header(default=None, alias="X-Admin-Key"),
    db: Session = Depends(get_db),
    search: Optional[str] = None,
    used: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
) -> dict:
    _verify_admin_key(admin_key)

    if limit < 1 or limit > 100:
        limit = 20
    if offset < 0:
        offset = 0

    query = db.query(ActivationCode).options(joinedload(ActivationCode.activated_user))

    if search:
        keyword = f"%{search.strip()}%"
        query = query.outerjoin(User, ActivationCode.id == User.activation_code_id).filter(
            or_(
                ActivationCode.code.ilike(keyword),
                ActivationCode.remark.ilike(keyword),
                User.username.ilike(keyword),
            )
        )

    if used == "used":
        query = query.filter(ActivationCode.used_count >= ActivationCode.max_uses)
    elif used == "unused":
        query = query.filter(ActivationCode.used_count < ActivationCode.max_uses)

    total = query.count()

    rows = (
        query.order_by(ActivationCode.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    def _to_dict(code: ActivationCode) -> dict:
        remaining_days, remaining_label = _compute_remaining_days(code)
        is_used = code.used_count >= code.max_uses
        user = code.activated_user
        return {
            "id": code.id,
            "code": code.code,
            "code_type": code.code_type,
            "trial_days": code.trial_days,
            "max_uses": code.max_uses,
            "used_count": code.used_count,
            "expires_at": code.expires_at.isoformat() if code.expires_at else None,
            "is_active": code.is_active,
            "remark": code.remark,
            "created_at": code.created_at.isoformat() if code.created_at else "",
            "status": "已使用" if is_used else "未使用",
            "remaining_days": remaining_days,
            "remaining_label": remaining_label,
            "activated_at": user.activated_at.isoformat() if user and user.activated_at else None,
            "activated_user_name": user.username if user else None,
        }

    return {"total": total, "offset": offset, "limit": limit, "items": [_to_dict(r) for r in rows]}
