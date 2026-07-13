# -*- coding: utf-8 -*-
"""Manage activation codes for Voicevideo.

Examples:
    python tools/manage_activation_codes.py generate --count 5 --type permanent
    python tools/manage_activation_codes.py generate --count 3 --type trial --days 7 --remark "小红书推广"
    python tools/manage_activation_codes.py list
    python tools/manage_activation_codes.py disable LAZE-XXXX-XXXX-XXXX
    python tools/manage_activation_codes.py grant testuser
"""

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER_DIR))

from app.activation import generate_activation_codes, normalize_code_input
from app.db import SessionLocal
from app.models import ActivationCode, User


def list_codes():
    db = SessionLocal()
    try:
        rows = db.query(ActivationCode).order_by(ActivationCode.created_at.desc()).all()
        if not rows:
            print("No activation codes found.")
            return
        print(f"{'Code':<24} {'Type':<10} {'Uses':<8} {'Active':<7} {'Status':<8} {'Remark':<20}")
        print("-" * 90)
        for row in rows:
            uses = f"{row.used_count}/{row.max_uses}"
            status = "used" if row.used_count >= row.max_uses else "unused"
            remark = (row.remark or "")[:20]
            print(
                f"{row.code:<24} {row.code_type:<10} {uses:<8} "
                f"{'Yes' if row.is_active else 'No':<7} {status:<8} {remark:<20}"
            )
    finally:
        db.close()


def disable_code(code_text: str) -> bool:
    normalized = normalize_code_input(code_text)
    if not normalized:
        print("Invalid code format.")
        return False
    db = SessionLocal()
    try:
        row = db.query(ActivationCode).filter(ActivationCode.code == normalized).first()
        if not row:
            print(f"Code {normalized} not found.")
            return False
        row.is_active = False
        db.commit()
        print(f"Disabled {normalized}.")
        return True
    finally:
        db.close()


def grant_user(username: str) -> bool:
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username.lower().strip()).first()
        if not user:
            print(f"User {username} not found.")
            return False
        user.is_activated = True
        user.activated_at = datetime.now(timezone.utc)
        user.activation_expires_at = None
        db.commit()
        print(f"Granted activation to user {username}.")
        return True
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description="Manage Voicevideo activation codes")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate", help="Generate activation codes")
    gen.add_argument("--count", type=int, default=1, help="Number of codes")
    gen.add_argument(
        "--type", choices=["permanent", "trial"], default="permanent", help="Code type"
    )
    gen.add_argument(
        "--days", type=int, default=7, help="Trial days (for trial codes)"
    )
    gen.add_argument(
        "--remark", type=str, default=None, help="Remark (order/customer info)"
    )

    sub.add_parser("list", help="List activation codes")

    dis = sub.add_parser("disable", help="Disable an activation code")
    dis.add_argument("code", help="Activation code")

    grant = sub.add_parser("grant", help="Grant activation to a user (dev helper)")
    grant.add_argument("username", help="Username")

    args = parser.parse_args()

    if args.command == "generate":
        db = SessionLocal()
        try:
            codes = generate_activation_codes(
                db,
                count=args.count,
                code_type=args.type,
                trial_days=args.days if args.type == "trial" else None,
                remark=args.remark,
            )
        finally:
            db.close()
        print(f"Generated {len(codes)} {args.type} code(s):")
        for code in codes:
            print(code)
    elif args.command == "list":
        list_codes()
    elif args.command == "disable":
        disable_code(args.code)
    elif args.command == "grant":
        grant_user(args.username)


if __name__ == "__main__":
    main()
