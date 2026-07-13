#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建期检查/下载文案改写模型。幂等：模型已存在时直接退出。"""

import os
import sys
from pathlib import Path


def _reconfigure_stdio():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def _setup_localdep():
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent
    localdep = project_root / "localdep"
    if localdep.is_dir():
        os.environ.setdefault("MODELSCOPE_CACHE", str(localdep / "modelscope"))
        os.environ.setdefault("HF_HOME", str(localdep / "huggingface"))


def _load_config():
    script_dir = Path(__file__).resolve().parent
    config_path = script_dir / "rewrite_config.json"
    defaults = {
        "model_id": "qwen/Qwen2.5-0.5B-Instruct",
        "use_modelscope": True,
    }
    if config_path.is_file():
        try:
            import json
            with open(config_path, "r", encoding="utf-8") as f:
                defaults.update(json.load(f))
        except Exception:
            pass
    return defaults


def _model_present(cache_dir: Path, model_id: str) -> bool:
    # ModelScope 缓存目录结构：cache_dir/models/<org>--<model>/<revision>/
    expected = cache_dir / "models" / model_id.replace("/", "--")
    if not expected.is_dir():
        return False
    # 只要存在任意 safetensors 或 bin 文件即认为已下载
    for pattern in ("model.safetensors", "pytorch_model.bin"):
        for candidate in expected.rglob(pattern):
            if candidate.is_file():
                return True
    return False


def main():
    _reconfigure_stdio()
    _setup_localdep()
    config = _load_config()

    model_id = config["model_id"]
    use_modelscope = bool(config.get("use_modelscope", True))
    cache_dir = Path(config.get("cache_dir", str(Path(__file__).resolve().parent.parent / "localdep" / "modelscope")))

    print(f"[ensure_rewrite_model] model={model_id}, cache={cache_dir}", flush=True)

    if _model_present(cache_dir, model_id):
        print("[ensure_rewrite_model] model already present, skipping download.", flush=True)
        return 0

    print("[ensure_rewrite_model] model not found, downloading...", flush=True)
    if use_modelscope:
        from modelscope import snapshot_download
        snapshot_download(model_id, cache_dir=str(cache_dir))
    else:
        from huggingface_hub import snapshot_download
        snapshot_download(model_id, cache_dir=str(cache_dir))

    if not _model_present(cache_dir, model_id):
        print("[ensure_rewrite_model] ERROR: download completed but model files are missing.", flush=True)
        return 1

    print("[ensure_rewrite_model] download complete.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
