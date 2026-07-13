#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建期确保 DashScope wan2.2-s2v 云端生成所需依赖已安装。幂等：已存在时跳过。"""

import sys


def _reconfigure_stdio():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def check(name):
    try:
        mod = __import__(name)
        version = getattr(mod, "__version__", "unknown")
        print(f"[ensure_dashscope_deps] {name} {version} already available, skip.", flush=True)
        return True
    except Exception as e:
        print(f"[ensure_dashscope_deps] ERROR: {name} not available: {e}", flush=True)
        return False


def main():
    _reconfigure_stdio()
    ok = True
    ok = check("requests") and ok
    ok = check("pydub") and ok
    ok = check("PIL") and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
