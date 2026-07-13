# -*- coding: utf-8 -*-
"""健康检查接口。"""

from datetime import datetime, timezone
from fastapi import APIRouter

from app.config import SERVICE_NAME, SERVICE_VERSION

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
async def health_check() -> dict:
    """前后端握手接口，返回服务基本状态。"""
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
