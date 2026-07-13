# -*- coding: utf-8 -*-
"""Lightweight migration helper for SQLite.

The project does not use Alembic. This module adds missing columns/tables
so existing databases continue to work after model changes.
"""

from sqlalchemy import inspect, text

from app.db import Base, engine
from app.models import ActivationCode, User


def _table_exists(table_name: str) -> bool:
    inspector = inspect(engine)
    return table_name in inspector.get_table_names()


def _get_columns(table_name: str) -> set[str]:
    inspector = inspect(engine)
    return {col["name"] for col in inspector.get_columns(table_name)}


def _column_type_sql(column) -> str:
    """Return a SQLite-ish type string for a SQLAlchemy column."""
    return str(column.type)


def migrate() -> None:
    Base.metadata.create_all(bind=engine)

    if not _table_exists("users"):
        return

    existing = _get_columns("users")
    required = {
        "is_activated": User.is_activated,
        "activation_code_id": User.activation_code_id,
        "activated_at": User.activated_at,
        "activation_expires_at": User.activation_expires_at,
    }

    with engine.begin() as conn:
        for name, column in required.items():
            if name in existing:
                continue
            sql_type = _column_type_sql(column)
            nullable = "NULL" if column.nullable else "NOT NULL"
            default = ""
            if column.default is not None and hasattr(column.default, "arg"):
                # Keep it simple: bool defaults are passed inline.
                pass
            if name == "is_activated":
                default = "DEFAULT 0"
            stmt = f'ALTER TABLE users ADD COLUMN {name} {sql_type} {nullable} {default}'
            conn.execute(text(stmt))

    # Ensure activation_codes columns exist.
    if _table_exists("activation_codes"):
        code_cols = _get_columns("activation_codes")
        required_code_cols = {
            "remark": ActivationCode.remark,
        }
        with engine.begin() as conn:
            for name, column in required_code_cols.items():
                if name in code_cols:
                    continue
                sql_type = _column_type_sql(column)
                nullable = "NULL" if column.nullable else "NOT NULL"
                stmt = f'ALTER TABLE activation_codes ADD COLUMN {name} {sql_type} {nullable}'
                conn.execute(text(stmt))


if __name__ == "__main__":
    migrate()
    print("Migration completed.")
