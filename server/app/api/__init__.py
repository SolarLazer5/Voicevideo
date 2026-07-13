# -*- coding: utf-8 -*-
"""API 路由聚合。"""

from fastapi import APIRouter

from app.api import admin, auth, health, update

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(update.router)
api_router.include_router(auth.router)
api_router.include_router(admin.router)
