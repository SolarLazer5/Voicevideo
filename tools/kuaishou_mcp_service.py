#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
快手 MCP 服务封装（基于 social-auto-upload 的 KSVideo）。

在 social-auto-upload 仓库根目录下运行，监听 127.0.0.1:18063。
提供与抖音 MCP 同构的 REST 接口：
    GET  /health
    GET  /api/v1/login/status
    GET  /api/v1/login/qrcode
    POST /api/v1/publish
    GET  /api/v1/publish/{task_id}
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
import uuid
from pathlib import Path

# 确保在 social-auto-upload 根目录下能找到 uploader/conf 等包
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from fastapi import BackgroundTasks, FastAPI
from pydantic import BaseModel
import uvicorn

# social-auto-upload 快手上传器
from uploader.ks_uploader.main import cookie_auth, get_ks_cookie, KSVideo

app = FastAPI(title="Kuaishou MCP Service", version="1.0.0")

# 配置 -------------------------------------------------------------------------
COOKIE_DIR = Path("cookies")
COOKIE_FILE = COOKIE_DIR / "kuaishou.json"
HEADLESS = os.environ.get("KUAISHOU_HEADLESS", "1") != "0"

COOKIE_DIR.mkdir(parents=True, exist_ok=True)

# 全局状态 ---------------------------------------------------------------------
_login_state = {
    "running": False,
    "done": False,
    "success": False,
    "qrcode": None,  # dict: {image_path, image_data_url}
    "message": "",
    "lock": threading.Lock(),
    "last_check": 0,
    "cached_logged_in": False,
}

_publish_tasks: dict[str, dict] = {}


# 内部辅助 ---------------------------------------------------------------------
def _run_async(coro):
    """在线程中运行一个 async 函数直到完成。"""
    return asyncio.run(coro)


def _login_worker():
    """后台执行快手扫码登录。"""
    global _login_state
    with _login_state["lock"]:
        _login_state["running"] = True
        _login_state["done"] = False
        _login_state["success"] = False
        _login_state["qrcode"] = None
        _login_state["message"] = ""

    async def qrcode_callback(payload: dict):
        with _login_state["lock"]:
            _login_state["qrcode"] = payload

    try:
        result = _run_async(
            get_ks_cookie(
                str(COOKIE_FILE),
                qrcode_callback=qrcode_callback,
                headless=HEADLESS,
            )
        )
        with _login_state["lock"]:
            _login_state["done"] = True
            _login_state["success"] = bool(result.get("success", False))
            _login_state["message"] = result.get("message", "")
    except Exception as exc:
        with _login_state["lock"]:
            _login_state["done"] = True
            _login_state["success"] = False
            _login_state["message"] = str(exc)
    finally:
        with _login_state["lock"]:
            _login_state["running"] = False


def _publish_worker(
    task_id: str,
    title: str,
    content: str,
    video_path: str,
    tags: list[str],
):
    """后台执行快手视频发布。"""
    task = _publish_tasks.setdefault(
        task_id,
        {"status": "accepted", "message": "任务已接受", "post_id": ""},
    )
    task["status"] = "running"
    task["message"] = "正在上传视频到快手..."

    async def run():
        video = KSVideo(
            title=title,
            file_path=video_path,
            tags=tags,
            publish_date=0,
            account_file=str(COOKIE_FILE),
            headless=HEADLESS,
            desc=content or title,
        )
        await video.main()

    try:
        _run_async(run())
        task["status"] = "done"
        task["message"] = "发布成功"
        task["post_id"] = ""
    except Exception as exc:
        task["status"] = "error"
        task["message"] = str(exc)


# 数据模型 ---------------------------------------------------------------------
class PublishRequest(BaseModel):
    title: str
    content: str = ""
    video_path: str
    tags: list[str] = []
    visibility: str = "public"


# 接口 -------------------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/v1/login/status")
async def login_status():
    """查询当前是否已登录快手。"""
    if not COOKIE_FILE.is_file():
        return {"data": {"is_logged_in": False}}

    # 如果刚刚完成扫码登录，直接返回成功，避免再次启动浏览器校验
    with _login_state["lock"]:
        if _login_state["done"] and _login_state["success"]:
            return {"data": {"is_logged_in": True}}

    try:
        ok = await cookie_auth(str(COOKIE_FILE))
        return {"data": {"is_logged_in": bool(ok)}}
    except Exception as exc:
        return {"data": {"is_logged_in": False}, "error": str(exc)}


@app.get("/api/v1/login/qrcode")
async def login_qrcode(background_tasks: BackgroundTasks):
    """获取快手登录二维码；若已登录则直接返回 is_logged_in。"""
    # 优先检查是否已登录
    if COOKIE_FILE.is_file():
        try:
            ok = await cookie_auth(str(COOKIE_FILE))
            if ok:
                return {"data": {"is_logged_in": True}}
        except Exception:
            pass

    with _login_state["lock"]:
        # 已有二维码直接返回
        if _login_state["running"] and _login_state["qrcode"]:
            return {
                "data": {
                    "img": _login_state["qrcode"].get("image_data_url", ""),
                    "timeout": 180,
                }
            }

        # 之前失败或从未启动，则重置并启动新的登录任务
        if _login_state["done"] and not _login_state["success"]:
            _login_state["running"] = False
            _login_state["done"] = False

        if not _login_state["running"]:
            threading.Thread(target=_login_worker, daemon=True).start()

    # 等待二维码出现（最多 30 秒；social-auto-upload 内部解码二维码可能耗时）
    for _ in range(300):
        await asyncio.sleep(0.1)
        with _login_state["lock"]:
            if _login_state["qrcode"]:
                return {
                    "data": {
                        "img": _login_state["qrcode"].get("image_data_url", ""),
                        "timeout": 180,
                    }
                }

    return {"error": "未能及时获取二维码，请稍后重试"}


@app.post("/api/v1/publish")
async def publish(req: PublishRequest, background_tasks: BackgroundTasks):
    """提交快手视频发布任务。"""
    task_id = str(uuid.uuid4())
    _publish_tasks[task_id] = {
        "status": "accepted",
        "message": "任务已接受",
        "post_id": "",
    }
    background_tasks.add_task(
        _publish_worker,
        task_id,
        req.title,
        req.content,
        req.video_path,
        req.tags,
    )
    return {"status": "accepted", "task_id": task_id}


@app.get("/api/v1/publish/{task_id}")
async def publish_status(task_id: str):
    """查询发布任务状态。"""
    task = _publish_tasks.get(task_id)
    if not task:
        return {"status": "not_found"}
    return task


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=18063)
