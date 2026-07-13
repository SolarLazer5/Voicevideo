#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
快手一键发布代理脚本（social-auto-upload MCP 模式）。

职责：
1. 检查/启动 localdep/social-auto-upload 中的 FastAPI 服务（端口 18063）
2. 调用 POST /api/v1/publish 完成视频发布
3. 轮询任务状态并把结果写入 work_dir/output.json

前置条件：
- 已运行 tools/setup_kuaishou_mcp.ps1 部署 localdep/social-auto-upload/
"""

import json
import os
import pathlib
import subprocess
import sys
import time

import requests

BASE_URL = "http://localhost:18063"


def find_service_entry():
    """按优先级查找 kuaishou_mcp_service.py 入口。"""
    candidates = []

    env_localdep = os.environ.get("VOICEVIDEO_LOCALDEP")
    if env_localdep:
        candidates.append(pathlib.Path(env_localdep) / "social-auto-upload" / "kuaishou_mcp_service.py")

    script_dir = pathlib.Path(__file__).resolve().parent
    project_root = script_dir.parent
    candidates.append(project_root / "localdep" / "social-auto-upload" / "kuaishou_mcp_service.py")
    candidates.append(project_root / "github" / "social-auto-upload" / "kuaishou_mcp_service.py")

    for c in candidates:
        if c.is_file():
            return c
    return None


def find_venv_python(entry: pathlib.Path) -> pathlib.Path:
    """查找服务对应的 venv Python，失败则回退到 localdep/python。"""
    venv_python = entry.parent / ".venv" / "Scripts" / "python.exe"
    if venv_python.is_file():
        return venv_python

    project_root = pathlib.Path(__file__).resolve().parent.parent
    localdep_python = project_root / "localdep" / "python" / "python.exe"
    if localdep_python.is_file():
        return localdep_python
    return pathlib.Path("python.exe")


def service_is_running():
    try:
        r = requests.get(f"{BASE_URL}/health", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


def ensure_service():
    if service_is_running():
        return True

    entry = find_service_entry()
    if not entry:
        return False

    entry_dir = entry.parent
    data_dir = entry_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    log_path = data_dir / "service.log"

    python_exe = find_venv_python(entry)

    creationflags = (
        getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        | getattr(subprocess, "DETACHED_PROCESS", 0)
    )
    try:
        with open(log_path, "w", encoding="utf-8") as logf:
            subprocess.Popen(
                [str(python_exe), str(entry)],
                cwd=str(entry_dir),
                stdout=logf,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )
    except Exception as e:
        print(f"启动快手 MCP 服务失败: {e}", file=sys.stderr)
        return False

    for _ in range(120):
        if service_is_running():
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


def poll_publish(task_id: str, out_file: pathlib.Path):
    """轮询发布任务直到完成或超时。"""
    deadline = time.time() + 600  # 10 分钟
    while time.time() < deadline:
        try:
            r = requests.get(f"{BASE_URL}/api/v1/publish/{task_id}", timeout=10)
            data = r.json()
        except Exception as e:
            write_output(out_file, {"status": "running", "message": f"查询状态失败: {e}"})
            time.sleep(2)
            continue

        status = data.get("status")
        if status == "done":
            return True, data
        elif status == "error":
            return False, data.get("message", "发布失败")
        elif status == "running":
            write_output(out_file, {"status": "running", "message": data.get("message", "正在发布...")})
        time.sleep(2)

    return False, "发布超时"


def publish(args, out_file):
    if not ensure_service():
        return False, "快手 MCP 服务启动失败，请运行 tools/setup_kuaishou_mcp.ps1 部署服务"

    title = args.get("title", "").strip()
    content = args.get("content", "").strip()
    video = args.get("video", "").strip()
    tags = parse_tags(args.get("tags", []))

    if not title:
        return False, "缺少标题"
    if not video:
        return False, "缺少视频文件路径"
    if not pathlib.Path(video).is_file():
        return False, f"视频文件不存在: {video}"

    payload = {
        "title": title,
        "content": content,
        "video_path": str(pathlib.Path(video).resolve()),
        "tags": tags,
        "visibility": "public",
    }

    write_output(out_file, {"status": "running", "message": "正在调用快手发布接口，请稍候..."})

    try:
        r = requests.post(f"{BASE_URL}/api/v1/publish", json=payload, timeout=30)
    except Exception as e:
        return False, f"请求异常: {e}"

    if r.status_code != 200:
        return False, f"发布失败: HTTP {r.status_code} {r.text}"

    try:
        data = r.json()
    except Exception as e:
        return False, f"响应解析失败: {e}"

    if data.get("status") != "accepted" or not data.get("task_id"):
        return False, data.get("error") or "发布任务未被接受"

    task_id = data["task_id"]
    write_output(out_file, {"status": "running", "message": "快手发布任务已启动..."})

    ok, result = poll_publish(task_id, out_file)
    if ok:
        return True, result
    return False, result


def main():
    if len(sys.argv) < 2:
        print("用法: publish_kuaishou.py <args.json>", file=sys.stderr)
        return 1

    args_file = pathlib.Path(sys.argv[1])
    with open(args_file, "r", encoding="utf-8") as f:
        args = json.load(f)

    work_dir = pathlib.Path(args.get("work_dir", "."))
    out_file = work_dir / "output.json"

    write_output(out_file, {"status": "running", "message": "正在连接快手 MCP 服务..."})

    ok, result = publish(args, out_file)
    if ok:
        write_output(
            out_file,
            {
                "status": "done",
                "post_id": result.get("post_id", ""),
                "title": args.get("title", ""),
                "message": "发布成功",
            },
        )
        return 0

    write_output(out_file, {"status": "error", "error": result})
    return 1


if __name__ == "__main__":
    sys.exit(main())
