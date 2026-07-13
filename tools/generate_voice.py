#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 Qwen3-TTS 声音生成脚本。"""

import json
import os
import re
import sys
import time
import traceback
from pathlib import Path

import numpy as np
import torch


def _log(msg: str):
    """统一日志输出到 stderr，避免污染 stdout 的 JSON 结果。"""
    print(f"[voice] {msg}", file=sys.stderr, flush=True)


def _log_env_info():
    """打印环境信息，便于排查 GPU/CPU、依赖版本问题。"""
    _log(f"Python executable: {sys.executable}")
    _log(f"Python version: {sys.version.replace(chr(10), ' ')}")
    _log(f"torch version: {torch.__version__}")
    _log(f"torch file: {getattr(torch, '__file__', 'N/A')}")
    try:
        from importlib.metadata import version as pkg_version
        torch_meta = pkg_version('torch')
        torchaudio_meta = pkg_version('torchaudio')
        _log(f"torch metadata version: {torch_meta}")
        _log(f"torchaudio metadata version: {torchaudio_meta}")
        if torch_meta != torch.__version__:
            _log(f"WARNING: torch metadata version ({torch_meta}) does not match imported torch version ({torch.__version__})")
            _log("WARNING: stale dist-info may exist; consider cleaning build/localdep/python/Lib/site-packages/torch* and rebuilding")
    except Exception as e:
        _log(f"read metadata version failed: {e}")

    if torch.cuda.is_available():
        _log(f"CUDA available: True")
        _log(f"CUDA version: {torch.version.cuda}")
        _log(f"GPU count: {torch.cuda.device_count()}")
        for i in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(i)
            total_mb = props.total_memory / (1024 * 1024)
            _log(f"GPU {i}: {torch.cuda.get_device_name(i)} | total VRAM: {total_mb:.1f} MB")
    else:
        _log("CUDA available: False")

    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        _log("MPS available: True")
    else:
        _log("MPS available: False")


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
        _log(f"setup localdep: {localdep}")
        os.environ.setdefault("MODELSCOPE_CACHE", str(localdep / "modelscope"))
        os.environ.setdefault("HF_HOME", str(localdep / "huggingface"))
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(localdep / "huggingface" / "hub"))
    else:
        _log(f"localdep not found at {localdep}, use default cache")


SPEAKER_MAP = {
    "female-sales": "Vivian",
    "female-gentle": "Serena",
    "male-magnetic": "Uncle_Fu",
    "male-youth": "Dylan",
}

MODEL_MAP = {
    "classic": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    "fast": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
}

EMOTION_LABELS = {
    "happy": "高兴",
    "sad": "悲伤",
    "angry": "生气",
    "calm": "平静",
}


def _build_instruct(emotion: str, intensity: float) -> str:
    if emotion not in EMOTION_LABELS:
        return ""
    label = EMOTION_LABELS[emotion]
    if emotion == "calm":
        if intensity >= 0.7:
            return "用非常平静、舒缓的语气朗读。"
        if intensity >= 0.4:
            return "用比较平静、自然的语气朗读。"
        return "用平和、自然的语气朗读。"

    if intensity >= 0.8:
        adv = f"非常{label}"
    elif intensity >= 0.5:
        adv = f"比较{label}"
    elif intensity >= 0.2:
        adv = f"略带{label}"
    else:
        return ""
    return f"用{adv}的语气朗读。"


def _chunk_text(text: str, max_chars: int = 120) -> list:
    """按标点切分，避免单句过长导致模型生成失败。"""
    text = text.strip()
    if not text:
        return []
    # 先按句子级标点切分
    parts = re.split(r"([。！？；\n]+)", text)
    chunks = []
    cur = ""
    for i, part in enumerate(parts):
        if not part:
            continue
        cur += part
        # 当遇到标点或累计长度超过阈值时截断
        if re.match(r"^[。！？；\n]+$", part) or len(cur) >= max_chars:
            stripped = cur.strip()
            if stripped:
                chunks.append(stripped)
            cur = ""
    if cur.strip():
        chunks.append(cur.strip())
    return chunks if chunks else [text]


def _ensure_model_local(model_id: str):
    """优先从 modelscope 本地缓存获取模型目录，不存在则联网下载。"""
    try:
        from modelscope import snapshot_download
        cache_dir = Path(os.environ.get("MODELSCOPE_CACHE", Path(__file__).resolve().parent.parent / "localdep" / "modelscope"))
        local_dir = snapshot_download(model_id, cache_dir=str(cache_dir))
        return local_dir
    except Exception:
        # 兜底：允许 transformers 自动从 HF 下载
        return model_id


def _load_model(model_key: str):
    import io
    import torch

    model_id = MODEL_MAP.get(model_key, MODEL_MAP["classic"])
    _log(f"loading model: {model_id} (key={model_key})")
    local_dir = _ensure_model_local(model_id)
    _log(f"model local dir: {local_dir}")

    # 优先使用 GPU 加速推理，无 GPU 时回退到 CPU
    # 使用 float32：fp16 在 Qwen3-TTS 的 code_predictor 上会触发 device-side assert
    if torch.cuda.is_available():
        # device_map="auto" 在显存不足时会把部分层放到 meta device，
        # 导致生成阶段出现 "Tensor.item() cannot be called on meta tensors"，
        # 因此显式指定 cuda；若显存不足再回退 CPU。
        device_map = "cuda"
        dtype = torch.float32
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device_map = "mps"
        dtype = torch.float32
    else:
        device_map = "cpu"
        dtype = torch.float32

    _log(f"TTS device: {device_map}, dtype: {dtype}")

    # sox/flash-attn 等依赖在 import 时会打印警告到 stdout，先临时重定向避免污染 JSON 输出
    _stdout = sys.stdout
    sys.stdout = io.StringIO()
    try:
        from qwen_tts import Qwen3TTSModel
    finally:
        sys.stdout = _stdout

    try:
        model = Qwen3TTSModel.from_pretrained(
            local_dir,
            device_map=device_map,
            dtype=dtype,
        )
    except (RuntimeError, torch.cuda.OutOfMemoryError) as e:
        err_text = str(e)
        is_oom = "out of memory" in err_text.lower() or "CUDA" in err_text
        if is_oom and device_map != "cpu":
            _log(f"GPU OOM with device_map={device_map}: {err_text}")
            _log("falling back to CPU inference (will be slow)")
            device_map = "cpu"
            model = Qwen3TTSModel.from_pretrained(
                local_dir,
                device_map=device_map,
                dtype=dtype,
            )
        else:
            raise

    _log(f"model loaded on {device_map}")
    return model


def _to_numpy(item):
    """将模型输出（Tensor / ndarray / list）统一转为 numpy float32 数组。"""
    import torch
    if isinstance(item, torch.Tensor):
        return item.detach().cpu().to(torch.float32).numpy()
    if isinstance(item, np.ndarray):
        return item.astype(np.float32, copy=False)
    return np.array(item, dtype=np.float32)


def _apply_speed(audio: np.ndarray, sr: int, speed: float) -> np.ndarray:
    if speed <= 0 or abs(speed - 1.0) < 0.01:
        return audio
    try:
        import librosa
        return librosa.effects.time_stretch(audio, rate=speed)
    except Exception as e:
        print(f"[warn] speed stretch failed: {e}", file=sys.stderr, flush=True)
        return audio


def generate(args: dict) -> dict:
    text = args.get("text", "").strip()
    if not text:
        return {"error": "缺少文案"}

    speaker_preset = args.get("speaker", "female-sales")
    speaker = SPEAKER_MAP.get(speaker_preset, "Vivian")
    model_key = args.get("model", "classic")
    speed = float(args.get("speed", 1.0))
    emotion = args.get("emotion", "calm")
    intensity = float(args.get("emotion_intensity", 0.5))
    language = args.get("language", "Chinese")

    instruct = _build_instruct(emotion, intensity)

    _log(f"request: speaker={speaker}, model={model_key}, speed={speed}, emotion={emotion}, intensity={intensity}, language={language}")
    _log(f"text length: {len(text)} chars")

    try:
        model = _load_model(model_key)
    except Exception as e:
        traceback.print_exc()
        return {"error": f"模型加载失败：{e}"}

    try:
        import soundfile as sf

        chunks = _chunk_text(text)
        _log(f"text split into {len(chunks)} chunk(s)")
        _write_progress(args, 0, len(chunks), f"准备生成，共 {len(chunks)} 段音频")
        wav_parts = []
        sr = None

        with torch.inference_mode():
            for idx, chunk in enumerate(chunks, start=1):
                msg = f"正在生成第 {idx}/{len(chunks)} 段音频"
                _log(msg)
                _write_progress(args, idx - 1, len(chunks), msg)
                wavs, cur_sr = model.generate_custom_voice(
                    text=chunk,
                    speaker=speaker,
                    language=language,
                    instruct=instruct if instruct else None,
                    non_streaming_mode=True,
                )
                wav = _to_numpy(wavs[0])
                if sr is None:
                    sr = cur_sr
                wav_parts.append(wav)
                _log(f"chunk {idx} generated, samples={len(wav)}, sr={cur_sr}")

        if not wav_parts or sr is None:
            return {"error": "音频生成结果为空"}

        _write_progress(args, len(chunks), len(chunks), "正在保存音频...")
        full_audio = np.concatenate(wav_parts)
        _log(f"concatenated audio: samples={len(full_audio)}, sr={sr}")
        full_audio = _apply_speed(full_audio, sr, speed)

        work_dir = Path(args.get("work_dir", "."))
        work_dir.mkdir(parents=True, exist_ok=True)
        out_path = work_dir / "output.wav"
        sf.write(str(out_path), full_audio, sr)

        duration = float(len(full_audio)) / sr
        _log(f"audio saved: {out_path.resolve()}, duration={duration:.2f}s")
        return {
            "audio_path": str(out_path.resolve()),
            "duration": round(duration, 2),
        }
    except Exception as e:
        traceback.print_exc()
        return {"error": f"音频生成失败：{e}"}


def _write_output(result: dict, args: dict):
    out_text = json.dumps(result, ensure_ascii=False)
    print(out_text, flush=True)

    work_dir = args.get("work_dir")
    if work_dir:
        try:
            out_path = Path(work_dir) / "output.json"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(out_text)
        except Exception:
            traceback.print_exc()


def _write_progress(args: dict, current: int, total: int, message: str):
    """向 output.json 写入中间进度，供 C++ 轮询时读取。"""
    work_dir = args.get("work_dir")
    if not work_dir:
        return
    try:
        out_path = Path(work_dir) / "output.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "status": "running",
            "progress": {
                "current": current,
                "total": total,
                "message": message,
            },
        }
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False))
    except Exception:
        traceback.print_exc()


def main():
    _reconfigure_stdio()
    _setup_localdep()
    _log_env_info()

    args_path = sys.argv[1] if len(sys.argv) > 1 else None
    args = {}
    if args_path and Path(args_path).is_file():
        try:
            with open(args_path, "r", encoding="utf-8") as f:
                args = json.load(f)
        except Exception as e:
            _write_output({"error": f"读取参数失败：{e}"}, args)
            return

    result = generate(args)
    _write_output(result, args)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        traceback.print_exc()
        print(json.dumps({"error": f"脚本异常：{e}"}, ensure_ascii=False), flush=True)
        sys.exit(1)
