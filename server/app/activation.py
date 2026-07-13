# -*- coding: utf-8 -*-
"""Activation code generation and validation helpers."""

import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.models import ActivationCode

CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # Avoid ambiguous chars.


def generate_raw_segment(length: int) -> str:
    return "".join(secrets.choice(CHARSET) for _ in range(length))


def format_code(raw: str) -> str:
    """Format a 16-character alphanumeric string as PPPP-BBBB-BBBB-BBBB."""
    parts = [raw[i : i + 4] for i in range(0, len(raw), 4)]
    return "-".join(parts)


def normalize_code_input(value: str) -> str:
    """Normalize user-entered code to PPPP-BBBB-BBBB-BBBB."""
    s = value.upper().strip()
    alnum = "".join(ch for ch in s if ch.isalnum())
    if len(alnum) != 16:
        return ""
    return format_code(alnum)


def generate_activation_codes(
    db: Session,
    count: int,
    code_type: str,
    trial_days: Optional[int],
    remark: Optional[str] = None,
) -> list[str]:
    """Generate activation codes and persist them. Returns the generated codes."""
    now = datetime.now(timezone.utc)
    codes = []
    for _ in range(count):
        while True:
            prefix = generate_raw_segment(4)
            body = generate_raw_segment(12)
            code_text = format_code(prefix + body)
            existing = (
                db.query(ActivationCode)
                .filter(ActivationCode.code == code_text)
                .first()
            )
            if not existing:
                break

        expires_at = None
        if code_type == "trial" and trial_days:
            expires_at = now + timedelta(days=trial_days)

        record = ActivationCode(
            code=code_text,
            code_type=code_type,
            trial_days=trial_days if code_type == "trial" else None,
            max_uses=1,
            used_count=0,
            expires_at=expires_at,
            is_active=True,
            remark=remark,
        )
        db.add(record)
        codes.append(code_text)
    db.commit()
    return codes
