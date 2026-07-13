# -*- coding: utf-8 -*-
"""SQLAlchemy models."""

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
)

from sqlalchemy.orm import relationship
from app.db import Base


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class ActivationCode(Base):
    __tablename__ = "activation_codes"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String(64), unique=True, index=True, nullable=False)
    code_type = Column(String(16), default="permanent")  # permanent | trial
    trial_days = Column(Integer, nullable=True)
    max_uses = Column(Integer, default=1)
    used_count = Column(Integer, default=0)
    expires_at = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=True)
    remark = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=_utc_now)

    activated_user = relationship(
        "User",
        back_populates="activation_code",
        uselist=False,
        foreign_keys="User.activation_code_id",
    )


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(32), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    is_activated = Column(Boolean, default=False)
    activation_code_id = Column(
        Integer, ForeignKey("activation_codes.id"), nullable=True
    )
    activated_at = Column(DateTime, nullable=True)
    activation_expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utc_now)
    updated_at = Column(DateTime, default=_utc_now, onupdate=_utc_now)

    activation_code = relationship(
        "ActivationCode",
        back_populates="activated_user",
        foreign_keys="User.activation_code_id",
    )
