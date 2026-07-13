#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建期检查/下载 Qwen3-TTS 声音生成所需模型。幂等：已存在时跳过。"""

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
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(localdep / "huggingface" / "hub"))


MODEL_IDS = [
    "Qwen/Qwen3-TTS-Tokenizer-12Hz",
    "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
]


def _model_present(cache_dir: Path, model_id: str) -> bool:
    expected = cache_dir / "models" / model_id.replace("/", "--")
    if not expected.is_dir():
        return False
    for pattern in ("model.safetensors", "pytorch_model.bin", "config.json"):
        for candidate in expected.rglob(pattern):
            if candidate.is_file():
                return True
    return False


def main():
    _reconfigure_stdio()
    _setup_localdep()

    script_dir = Path(__file__).resolve().parent
    cache_dir = Path(os.environ.get("MODELSCOPE_CACHE", script_dir.parent / "localdep" / "modelscope"))

    try:
        from modelscope import snapshot_download
    except Exception as e:
        print(f"[ensure_tts_model] modelscope not available: {e}", flush=True)
        return 1

    all_ok = True
    for model_id in MODEL_IDS:
        print(f"[ensure_tts_model] checking {model_id} ...", flush=True)
        if _model_present(cache_dir, model_id):
            print(f"[ensure_tts_model] {model_id} already present, skip.", flush=True)
            continue
        print(f"[ensure_tts_model] downloading {model_id} ...", flush=True)
        try:
            snapshot_download(model_id, cache_dir=str(cache_dir))
        except Exception as e:
            print(f"[ensure_tts_model] ERROR downloading {model_id}: {e}", flush=True)
            all_ok = False
            continue
        if not _model_present(cache_dir, model_id):
            print(f"[ensure_tts_model] ERROR {model_id} download incomplete.", flush=True)
            all_ok = False
        else:
            print(f"[ensure_tts_model] {model_id} ready.", flush=True)

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
