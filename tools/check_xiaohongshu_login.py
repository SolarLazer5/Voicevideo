#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
检查小红书登录状态（供 C++ getXiaohongshuLoginStatus 同步调用）。

为了避免 headless 浏览器在检查登录状态时频繁超时/被反爬，
本脚本优先对 cookie 文件做本地校验：只要文件里包含关键 session cookie
且未过期，就认为当前账号已登录。只有在显式传入 force=true 或文件无效时，
才会fallback 到 MCP 服务的真实浏览器校验。
"""

import asyncio
import json
import pathlib
import sys
import time
import traceback

import aiohttp

# 复用 publish_xiaohongshu.py 的本地依赖设置、服务查找/启动逻辑
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from publish_xiaohongshu import (
    _setup_localdep,
    find_binary,
    ensure_service,
    get_mcp_endpoint,
)

# 小红书登录态里一般都会存在的关键 cookie（只要这些在且未过期，基本可认为已登录）
_REQUIRED_COOKIE_NAMES = {"web_session", "webId", "xhsTracker"}


def _check_cookie_file(cookie_path: str):
    """
    本地快速校验 cookie 文件。
    返回 (is_logged_in, message)。
    """
    try:
        p = pathlib.Path(cookie_path)
        if not p.is_file():
            return False, f"cookie 文件不存在: {cookie_path}"

        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, list) or len(data) == 0:
            return False, "cookie 文件内容为空或格式错误"

        now_ts = time.time()
        present_names = set()
        for c in data:
            if not isinstance(c, dict):
                continue
            name = c.get("name")
            if not name:
                continue
            # 检查是否已过期（服务端 expiry 是 TimeSinceEpoch 秒级时间戳）
            expires = c.get("expires")
            if isinstance(expires, (int, float)) and 0 < expires < now_ts:
                continue
            present_names.add(name)

        if _REQUIRED_COOKIE_NAMES & present_names:
            return True, "cookie 文件校验通过"
        return False, "cookie 文件中缺少关键登录态字段"
    except Exception as e:
        return False, f"cookie 文件校验异常: {e}"


async def _check_login(port: int):
    """向 MCP 服务调用 check_login_status，返回 (is_logged_in, message)。"""
    endpoint = get_mcp_endpoint(port)
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            endpoint,
            json={
                "jsonrpc": "2.0",
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "voicevideo", "version": "1.0"},
                },
                "id": 1,
            },
        ) as resp:
            resp.raise_for_status()
            session_id = resp.headers.get("Mcp-Session-Id")
            if not session_id:
                raise RuntimeError("MCP initialize 未返回 Mcp-Session-Id")

        async with session.post(
            endpoint,
            headers={"Mcp-Session-Id": session_id},
            json={
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {"name": "check_login_status", "arguments": {}},
                "id": 2,
            },
        ) as resp:
            resp.raise_for_status()
            data = await resp.json()
            result = data.get("result", {})
            texts = [
                item.get("text", "")
                for item in result.get("content", [])
                if isinstance(item, dict)
            ]
            text = "\n".join(texts)
            logged_in = ("已登录" in text) and ("未登录" not in text)
            return logged_in, text


def write_output(out_file, data):
    try:
        out_file = pathlib.Path(out_file)
        out_file.parent.mkdir(parents=True, exist_ok=True)
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"写入结果失败: {e}", file=sys.stderr)


def main():
    _setup_localdep()

    if len(sys.argv) < 2:
        print("用法: check_xiaohongshu_login.py <args.json>", file=sys.stderr)
        return 1

    args_file = pathlib.Path(sys.argv[1])
    with open(args_file, "r", encoding="utf-8") as f:
        args = json.load(f)

    work_dir = pathlib.Path(args.get("work_dir", "."))
    out_file = work_dir / "output.json"
    port = args.get("port", 18060)
    cookie_path = args.get("cookie_path")
    force_browser_check = args.get("force", False)

    # 快速通道：本地校验 cookie 文件，避免 headless 浏览器超时
    if cookie_path and not force_browser_check:
        logged_in, message = _check_cookie_file(cookie_path)
        if logged_in:
            write_output(
                out_file,
                {
                    "is_logged_in": True,
                    "message": message,
                },
            )
            return 0
        # 文件校验不通过时，继续走浏览器校验（可能是 cookie 真的过期了）

    binary = find_binary()
    if not ensure_service(binary, port=port, cookie_path=cookie_path):
        write_output(
            out_file,
            {
                "is_logged_in": False,
                "message": "小红书 MCP 服务启动失败",
            },
        )
        return 1

    try:
        logged_in, text = asyncio.run(_check_login(port))
        write_output(
            out_file,
            {
                "is_logged_in": logged_in,
                "message": text,
            },
        )
        return 0
    except Exception as e:
        traceback.print_exc()
        write_output(
            out_file,
            {
                "is_logged_in": False,
                "message": f"登录检查异常: {e}",
            },
        )
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        traceback.print_exc()
        print(json.dumps({"is_logged_in": False, "message": str(e)}, ensure_ascii=False))
        sys.exit(1)
