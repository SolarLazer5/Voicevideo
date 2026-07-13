#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Voicevideo 后端服务启动入口。

本地开发：
    python server/run.py

指定端口：
    set VOICEVIDEO_BACKEND_PORT=18080
    python server/run.py
"""

import uvicorn

from app.config import HOST, PORT

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=HOST,
        port=PORT,
        reload=False,
        log_level="info",
    )
