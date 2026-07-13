#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小红书一键发布 MCP 代理脚本。

职责：
1. 检查/启动 xiaohongshu-mcp 服务（端口 18060）
2. 通过 MCP 协议调用 check_login_status 确认登录
3. 通过 MCP 协议调用 publish_with_video 发布视频
4. 把进度/结果写入 work_dir/output.json

前置：
- localdep/xiaohongshu-mcp/xiaohongshu-mcp-windows-amd64.exe
- localdep/xiaohongshu-mcp/data/cookies.json（由登录工具生成）
"""

import asyncio
import json
import os
import pathlib
import subprocess
import sys
import time
import traceback

import aiohttp
import requests

DEFAULT_PORT = 18060
BASE_URL = f"http://localhost:{DEFAULT_PORT}"
MCP_ENDPOINT = f"{BASE_URL}/mcp"


def get_base_url(port=None):
    port = port or DEFAULT_PORT
    return f"http://localhost:{port}"


def get_mcp_endpoint(port=None):
    return f"{get_base_url(port)}/mcp"


def _setup_localdep():
    """同步 Voicevideo 的 localdep 环境变量约定。"""
    env_localdep = os.environ.get("VOICEVIDEO_LOCALDEP")
    if not env_localdep:
        script_dir = pathlib.Path(__file__).resolve().parent
        env_localdep = str(script_dir.parent / "localdep")
    env_localdep = pathlib.Path(env_localdep).resolve()
    os.environ.setdefault("MODELSCOPE_CACHE", str(env_localdep / "modelscope"))
    os.environ.setdefault("HF_HOME", str(env_localdep / "huggingface"))
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(env_localdep / "huggingface"))
    return env_localdep


def find_binary():
    """按优先级查找 xiaohongshu-mcp-windows-amd64.exe。"""
    name = "xiaohongshu-mcp-windows-amd64.exe"
    candidates = []

    env_localdep = os.environ.get("VOICEVIDEO_LOCALDEP")
    if env_localdep:
        candidates.append(pathlib.Path(env_localdep) / "xiaohongshu-mcp" / name)

    script_dir = pathlib.Path(__file__).resolve().parent
    project_root = script_dir.parent
    candidates.append(project_root / "localdep" / "xiaohongshu-mcp" / name)

    exe_dir = pathlib.Path(sys.executable).parent
    candidates.append(exe_dir / "localdep" / "xiaohongshu-mcp" / name)

    for c in candidates:
        if c.is_file():
            return c
    return None


def find_draft_binary():
    """按优先级查找 xiaohongshu-draft-windows-amd64.exe。"""
    name = "xiaohongshu-draft-windows-amd64.exe"
    candidates = []

    env_localdep = os.environ.get("VOICEVIDEO_LOCALDEP")
    if env_localdep:
        candidates.append(pathlib.Path(env_localdep) / "xiaohongshu-mcp" / name)

    script_dir = pathlib.Path(__file__).resolve().parent
    project_root = script_dir.parent
    candidates.append(project_root / "localdep" / "xiaohongshu-mcp" / name)

    exe_dir = pathlib.Path(sys.executable).parent
    candidates.append(exe_dir / "localdep" / "xiaohongshu-mcp" / name)

    for c in candidates:
        if c.is_file():
            return c
    return None


def find_browser(browser_path=""):
    """查找可用的 Chrome/Chromium/Edge 浏览器可执行文件。"""
    if browser_path:
        p = pathlib.Path(browser_path)
        if p.is_file():
            return str(p.resolve())

    env_browser = os.environ.get("ROD_BROWSER_BIN") or os.environ.get("BROWSER_PATH")
    if env_browser:
        p = pathlib.Path(env_browser)
        if p.is_file():
            return str(p.resolve())

    try:
        import winreg
        keys = [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
        ]
        for key_path in keys:
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path) as key:
                    val, _ = winreg.QueryValueEx(key, None)
                    if val and pathlib.Path(val).is_file():
                        return str(pathlib.Path(val).resolve())
            except Exception:
                continue
    except Exception:
        pass

    common_paths = [
        pathlib.Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google" / "Chrome" / "Application" / "chrome.exe",
        pathlib.Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        pathlib.Path(os.environ.get("LOCALAPPDATA", r"C:\Users")) / "Google" / "Chrome" / "Application" / "chrome.exe",
    ]
    for p in common_paths:
        if p.is_file():
            return str(p.resolve())

    return ""


def service_is_running(port=None):
    """检查 MCP 服务是否已启动（发送 JSON-RPC initialize）。"""
    try:
        r = requests.post(
            get_mcp_endpoint(port),
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
            timeout=3,
        )
        return r.status_code == 200
    except Exception:
        return False


def ensure_service(binary, port=None, cookie_path=None):
    port = port or DEFAULT_PORT
    if service_is_running(port):
        return True

    if not binary:
        return False

    data_dir = binary.parent / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    if not cookie_path:
        cookie_path = data_dir / "cookies.json"
    log_path = data_dir / f"service.{port}.log"

    env = os.environ.copy()
    env["COOKIES_PATH"] = str(cookie_path)

    creationflags = (
        getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        | getattr(subprocess, "DETACHED_PROCESS", 0)
    )

    try:
        with open(log_path, "w", encoding="utf-8") as logf:
            subprocess.Popen(
                [str(binary), "-port", f":{port}"],
                cwd=str(binary.parent),
                env=env,
                stdout=logf,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )
    except Exception as e:
        print(f"启动小红书服务失败: {e}", file=sys.stderr)
        return False

    for _ in range(120):
        if service_is_running(port):
            return True
        time.sleep(0.5)

    return False


def write_output(out_file, data):
    try:
        out_file = pathlib.Path(out_file)
        out_file.parent.mkdir(parents=True, exist_ok=True)
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"写入结果失败: {e}", file=sys.stderr)


def parse_tags(raw):
    if isinstance(raw, list):
        return [str(t).strip() for t in raw if str(t).strip()]
    if isinstance(raw, str):
        return [t.strip() for t in raw.replace("。", "").split() if t.strip()]
    return []


async def mcp_call_tool(tool_name, arguments, port=None):
    """直接通过 HTTP JSON-RPC 调用 MCP tool（绕过 httpx 与官方 client 的兼容性问题）。"""
    endpoint = get_mcp_endpoint(port)
    timeout = aiohttp.ClientTimeout(total=120)

    async with aiohttp.ClientSession(timeout=timeout) as session:
        # 1. initialize，获取 session id
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

        # 2. 调用 tool
        async with session.post(
            endpoint,
            headers={"Mcp-Session-Id": session_id},
            json={
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {"name": tool_name, "arguments": arguments or {}},
                "id": 2,
            },
        ) as resp:
            resp.raise_for_status()
            data = await resp.json()
            if data.get("error"):
                msg = data["error"].get("message", "MCP tool 调用返回错误")
                raise RuntimeError(msg)
            return data.get("result", {})


def extract_text(result):
    """从 MCP tool 结果中提取文本内容。"""
    # 新版直接返回 JSON-RPC result dict
    if isinstance(result, dict):
        if result.get("isError"):
            texts = [
                item.get("text", "")
                for item in result.get("content", [])
                if isinstance(item, dict)
            ]
            return "error", "; ".join(texts) if texts else "MCP tool 返回错误"
        texts = [
            item.get("text", "")
            for item in result.get("content", [])
            if isinstance(item, dict)
        ]
        text = "\n".join(texts) if texts else ""
        try:
            data = json.loads(text)
            if isinstance(data, dict):
                if data.get("success") is False:
                    return "error", data.get("error") or data.get("message") or "发布失败"
                return "ok", data
        except Exception:
            pass
        return "ok", text

    # 兼容旧版官方 SDK 的 CallToolResult 对象
    if getattr(result, "isError", False):
        texts = []
        for item in result.content:
            if hasattr(item, "text"):
                texts.append(item.text)
        return "error", "; ".join(texts) if texts else "MCP tool 返回错误"
    texts = []
    for item in result.content:
        if hasattr(item, "text"):
            texts.append(item.text)
    text = "\n".join(texts) if texts else ""
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            if data.get("success") is False:
                return "error", data.get("error") or data.get("message") or "发布失败"
            return "ok", data
    except Exception:
        pass
    return "ok", text


def main():
    _setup_localdep()

    if len(sys.argv) < 2:
        print("用法: publish_xiaohongshu.py <args.json>", file=sys.stderr)
        return 1

    args_file = pathlib.Path(sys.argv[1])
    with open(args_file, "r", encoding="utf-8") as f:
        args = json.load(f)

    work_dir = pathlib.Path(args.get("work_dir", "."))
    out_file = work_dir / "output.json"

    port = args.get("port", DEFAULT_PORT)
    cookie_path = args.get("cookie_path")

    title = args.get("title", "").strip()
    content = args.get("content", "").strip()
    video = args.get("video", "").strip()
    cover = args.get("cover", "").strip()
    tags = parse_tags(args.get("tags", []))
    mode = args.get("mode", "direct").strip().lower()
    is_draft = mode == "draft"

    if not title:
        write_output(out_file, {"status": "error", "error": "缺少标题"})
        return 1
    if not video:
        write_output(out_file, {"status": "error", "error": "缺少视频文件路径"})
        return 1
    if not pathlib.Path(video).is_file():
        write_output(out_file, {"status": "error", "error": f"视频文件不存在: {video}"})
        return 1
    if cover and not pathlib.Path(cover).is_file():
        cover = ""

    # 小红书标题限制 20 字
    if len(title) > 20:
        title = title[:20]

    if is_draft:
        # 草稿模式快速通道：前端已经完成登录状态检查，这里直接启动草稿工具，
        # 不再启动 MCP 服务、不再做二次登录校验。
        write_output(out_file, {"status": "running", "message": "正在打开小红书创作平台..."})
        binary = find_draft_binary()
        if not binary:
            write_output(
                out_file,
                {
                    "status": "error",
                    "error": "未找到 xiaohongshu-draft-windows-amd64.exe，请重新编译并放置到 localdep/xiaohongshu-mcp/ 目录。",
                },
            )
            return 1

        browser_path = find_browser(args.get("browser_path", ""))

        cmd = [
            str(binary),
            "-title", title,
            "-content", content,
            "-video", str(pathlib.Path(video).resolve()),
            "-tags", ",".join(tags),
            "-cookie", str(pathlib.Path(cookie_path).resolve()),
        ]
        if cover:
            cmd += ["-cover", str(pathlib.Path(cover).resolve())]
        if browser_path:
            cmd += ["-bin", browser_path]

        data_dir = binary.parent / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        log_path = data_dir / "draft.log"

        creationflags = (
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
        )

        try:
            with open(log_path, "w", encoding="utf-8") as logf:
                subprocess.Popen(
                    cmd,
                    cwd=str(binary.parent),
                    env=os.environ.copy(),
                    stdout=logf,
                    stderr=subprocess.STDOUT,
                    creationflags=creationflags,
                )
        except Exception as e:
            traceback.print_exc()
            write_output(out_file, {"status": "error", "error": f"启动草稿工具失败: {e}"})
            return 1

        write_output(
            out_file,
            {
                "status": "done",
                "message": "已打开小红书创作平台，请继续编辑并保存草稿。",
                "mode": "draft",
            },
        )
        return 0

    # 直接发布：走后台 MCP 服务 headless 自动发布。
    # 前端在点击发布前已做过真实登录检查，这里跳过二次 check_login_status。
    write_output(out_file, {"status": "running", "message": "正在连接小红书服务..."})
    binary = find_binary()
    if not ensure_service(binary, port=port, cookie_path=cookie_path):
        write_output(
            out_file,
            {
                "status": "error",
                "error": (
                    "小红书 MCP 服务启动失败，请确认已将 "
                    "xiaohongshu-mcp-windows-amd64.exe 放置到 "
                    "localdep/xiaohongshu-mcp/ 目录，并已通过 "
                    "xiaohongshu-login-windows-amd64.exe 完成登录。"
                ),
            },
        )
        return 1

    schedule_at = ""
    visibility = "公开可见"

    payload = {
        "title": title,
        "content": content,
        "video": str(pathlib.Path(video).resolve()),
        "tags": tags,
        "schedule_at": schedule_at,
        "visibility": visibility,
        "is_draft": False,
    }
    if cover:
        payload["cover"] = str(pathlib.Path(cover).resolve())

    write_output(out_file, {"status": "running", "message": "正在发布视频到小红书，请稍候..."})

    try:
        result = asyncio.run(mcp_call_tool("publish_with_video", payload, port=port))
        status, info = extract_text(result)
        if status == "error":
            write_output(out_file, {"status": "error", "error": info})
            return 1
        write_output(
            out_file,
            {
                "status": "done",
                "message": "发布成功",
                "mode": mode,
                "post_id": info.get("post_id", "") if isinstance(info, dict) else "",
                "detail": info if isinstance(info, str) else "",
            },
        )
    except Exception as e:
        write_output(out_file, {"status": "error", "error": f"发布异常: {e}"})
        return 1

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False))
        sys.exit(1)
