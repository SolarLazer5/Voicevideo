# -*- coding: utf-8 -*-
"""Voicevideo backend configuration."""

import os

# Server listen port, overridable via environment variable
PORT: int = int(os.environ.get("VOICEVIDEO_BACKEND_PORT", "18080"))

# Server listen host, 0.0.0.0 for local network debugging
HOST: str = os.environ.get("VOICEVIDEO_BACKEND_HOST", "0.0.0.0")

# Service metadata
SERVICE_NAME: str = "voicevideo-backend"
SERVICE_VERSION: str = "1.0.0"

# CORS: allow file:// (null origin) and any debugging origin
CORS_ORIGINS: list[str] = ["*"]

# JWT settings
# IMPORTANT: set VOICEVIDEO_JWT_SECRET in production; the fallback is for development only.
JWT_SECRET_KEY: str = os.environ.get(
    "VOICEVIDEO_JWT_SECRET",
    "voicevideo-dev-secret-change-in-production",
)
JWT_ALGORITHM: str = "HS256"
JWT_ACCESS_TOKEN_EXPIRE_DAYS: int = int(
    os.environ.get("VOICEVIDEO_JWT_EXPIRE_DAYS", "30")
)

# Admin panel secret key for generating/listing activation codes.
# Set VOICEVIDEO_ADMIN_SECRET in production; the fallback is for development only.
ADMIN_SECRET_KEY: str = os.environ.get(
    "VOICEVIDEO_ADMIN_SECRET",
    "voicevideo-dev-admin-secret-change-in-production",
)
