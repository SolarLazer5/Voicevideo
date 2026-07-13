#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Video generation backend: portrait image + audio -> talking-head MP4 via SadTalker.

This script is launched by Voicevideo.exe (via startPythonScript). It reads
args.json, runs SadTalker inference, and writes progress/result to output.json.
"""
import json
import os
import shutil
import subprocess
import sys
import traceback
import types
import uuid
import warnings
from pathlib import Path

import numpy as np
import cv2

warnings.filterwarnings("ignore")


def _log(msg: str):
    print(f"[video] {msg}", flush=True, file=sys.stderr)


def _write_progress(work_dir: Path, status: str, percent: int = 0, message: str = "", video_path: str = "", error: str = ""):
    payload = {
        "status": status,
        "progress": {"percent": percent, "message": message},
    }
    if video_path:
        payload["video_path"] = str(video_path)
    if error:
        payload["error"] = str(error)
    try:
        out = work_dir / "output.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
    except Exception as e:
        _log(f"failed to write progress: {e}")


def _patch_numpy():
    """SadTalker was written for NumPy 1.x; restore removed aliases."""
    for attr, repl in [
        ("float", float),
        ("int", int),
        ("bool", bool),
        ("object", object),
        ("str", str),
    ]:
        if not hasattr(np, attr):
            setattr(np, attr, repl)
    if not hasattr(np, "VisibleDeprecationWarning"):
        np.VisibleDeprecationWarning = DeprecationWarning

    # np.linalg.lstsq in NumPy 2.x may return column-vector coefficients.
    _orig_lstsq = np.linalg.lstsq

    def _lstsq(a, b, rcond=None):
        r = _orig_lstsq(a, b, rcond)
        return (np.squeeze(r[0]),) + r[1:]

    np.linalg.lstsq = _lstsq

    # float(np.array([x])) no longer works in NumPy 2.x; SadTalker uses this once.
    _orig_hsplit = np.hsplit

    def _hsplit(ary, indices_or_sections):
        return [np.squeeze(r) for r in _orig_hsplit(ary, indices_or_sections)]

    np.hsplit = _hsplit


def _patch_librosa():
    """SadTalker uses librosa.core.load, removed in newer librosa."""
    import librosa

    if not hasattr(librosa, "core"):
        librosa.core = types.SimpleNamespace()
    if not hasattr(librosa.core, "load"):
        librosa.core.load = librosa.load


def _patch_gfpgan():
    """Avoid heavy gfpgan dependency; we never use face enhancement."""
    gfpgan = types.ModuleType("gfpgan")

    class GFPGANer:
        def __init__(self, *args, **kwargs):
            pass

        def enhance(self, img, *args, **kwargs):
            return img, 0

    gfpgan.GFPGANer = GFPGANer
    sys.modules["gfpgan"] = gfpgan


def _patch_face_enhancer():
    fe = types.ModuleType("src.utils.face_enhancer")
    fe.enhancer_generator_with_len = lambda images, *a, **k: images
    fe.enhancer_list = lambda images, *a, **k: list(images)
    sys.modules["src.utils.face_enhancer"] = fe


def _patch_videoio():
    """Use imageio-ffmpeg's bundled ffmpeg instead of requiring system ffmpeg."""
    import src.utils.videoio as vio
    from imageio_ffmpeg import get_ffmpeg_exe

    def _save(video, audio, save_path, watermark=False):
        temp = str(uuid.uuid4()) + ".mp4"
        ffmpeg = get_ffmpeg_exe()
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                video,
                "-i",
                audio,
                "-vcodec",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-acodec",
                "copy",
                "-movflags",
                "+faststart",
                temp,
            ],
            check=True,
        )
        shutil.move(temp, save_path)

    vio.save_video_with_watermark = _save


def _patch_align_img():
    """Ensure align_img returns a 1-D trans_params array."""
    import src.face3d.util.preprocess as f3dpre
    import src.utils.preprocess as upre

    _orig = f3dpre.align_img

    def _align_img(img, lm, lm3D, mask=None, target_size=224.0, rescale_factor=102.0):
        trans_params, img_new, lm_new, mask_new = _orig(img, lm, lm3D, mask, target_size, rescale_factor)
        return np.asarray(trans_params).flatten(), img_new, lm_new, mask_new

    upre.align_img = _align_img


def _patch_paste_pic(options: dict):
    """用羽化椭圆 mask 替换 paste_pic 的硬边矩形 mask，减弱 SadTalker 拼接痕迹。"""
    feather_ratio = float(options.get("paste_feather_ratio", 0.25))
    clone_mode_str = str(options.get("paste_clone_mode", "normal")).lower()
    clone_flag = cv2.MIXED_CLONE if clone_mode_str == "mixed" else cv2.NORMAL_CLONE

    import src.utils.paste_pic as ppmod
    import src.facerender.animate as animate_mod

    _save_video = ppmod.save_video_with_watermark

    def _create_feather_mask(h, w, ratio):
        mask = np.zeros((h, w), dtype=np.uint8)
        center = (w // 2, h // 2)
        axes = (int(w * (1 - ratio) / 2), int(h * (1 - ratio) / 2))
        cv2.ellipse(mask, center, axes, 0, 0, 360, 255, -1)
        ksize = max(5, int(min(h, w) * ratio) // 2 * 2 + 1)
        mask = cv2.GaussianBlur(mask, (ksize, ksize), 0)
        return mask

    def paste_pic(video_path, pic_path, crop_info, new_audio_path, full_video_path, extended_crop=False):
        from tqdm import tqdm
        if not os.path.isfile(pic_path):
            raise ValueError('pic_path must be a valid path to video/image file')
        elif pic_path.split('.')[-1] in ['jpg', 'png', 'jpeg']:
            full_img = cv2.imread(pic_path)
        else:
            video_stream = cv2.VideoCapture(pic_path)
            while True:
                still_reading, frame = video_stream.read()
                if not still_reading:
                    video_stream.release()
                    break
                break
            full_img = frame

        frame_h, frame_w = full_img.shape[:2]
        video_stream = cv2.VideoCapture(video_path)
        fps = video_stream.get(cv2.CAP_PROP_FPS)
        crop_frames = []
        while True:
            still_reading, frame = video_stream.read()
            if not still_reading:
                video_stream.release()
                break
            crop_frames.append(frame)

        if len(crop_info) != 3:
            print("you didn't crop the image")
            return

        r_w, r_h = crop_info[0]
        clx, cly, crx, cry = crop_info[1]
        lx, ly, rx, ry = crop_info[2]
        lx, ly, rx, ry = int(lx), int(ly), int(rx), int(ry)

        if extended_crop:
            oy1, oy2, ox1, ox2 = cly, cry, clx, crx
        else:
            oy1, oy2, ox1, ox2 = cly + ly, cly + ry, clx + lx, clx + rx

        tmp_path = str(uuid.uuid4()) + '.mp4'
        out_tmp = cv2.VideoWriter(tmp_path, cv2.VideoWriter_fourcc(*'MP4V'), fps, (frame_w, frame_h))

        p_h, p_w = oy2 - oy1, ox2 - ox1
        feather_mask = _create_feather_mask(p_h, p_w, feather_ratio)

        for crop_frame in tqdm(crop_frames, 'seamlessClone:'):
            p = cv2.resize(crop_frame.astype(np.uint8), (p_w, p_h))
            location = ((ox1 + ox2) // 2, (oy1 + oy2) // 2)
            gen_img = cv2.seamlessClone(p, full_img, feather_mask, location, clone_flag)
            out_tmp.write(gen_img)

        out_tmp.release()
        _save_video(tmp_path, new_audio_path, full_video_path, watermark=False)
        os.remove(tmp_path)

    ppmod.paste_pic = paste_pic
    animate_mod.paste_pic = paste_pic


def _install_tqdm_hook(work_dir: Path):
    """Capture SadTalker's tqdm progress and mirror it to output.json."""
    from tqdm import tqdm as _orig_tqdm

    class _TqdmHook(_orig_tqdm):
        def __init__(self, *args, **kwargs):
            self._vv_desc = kwargs.get("desc", "")
            super().__init__(*args, **kwargs)

        def update(self, n=1):
            super().update(n)
            desc = getattr(self, "_vv_desc", "")
            total = getattr(self, "total", None)
            n_cur = getattr(self, "n", 0)
            if desc == "Face Renderer:" and total:
                percent = min(95, 60 + int(35 * n_cur / total))
                _write_progress(work_dir, "running", percent, "正在渲染说话人脸视频...")

    import tqdm as tqdm_mod

    tqdm_mod.tqdm = _TqdmHook


def generate(args: dict) -> dict:
    work_dir = Path(args.get("work_dir")).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)

    source_image = Path(args["source_image"]).resolve()
    audio_path = Path(args["audio_path"]).resolve()
    output_path = Path(args["output_path"]).resolve()
    sadtalker_root = Path(args["sadtalker_root"]).resolve()

    if not source_image.is_file():
        raise FileNotFoundError(f"形象图片不存在: {source_image}")
    if not audio_path.is_file():
        raise FileNotFoundError(f"驱动音频不存在: {audio_path}")

    _log(f"source_image={source_image}, audio={audio_path}, output={output_path}")
    _log(f"sadtalker_root={sadtalker_root}")

    _write_progress(work_dir, "running", 5, "加载 SadTalker 环境...")

    sys.path.insert(0, str(sadtalker_root))
    os.chdir(sadtalker_root)

    _patch_numpy()
    _patch_librosa()
    _patch_gfpgan()
    _patch_face_enhancer()
    _install_tqdm_hook(work_dir)

    import torch
    from src.facerender.animate import AnimateFromCoeff
    from src.generate_batch import get_data
    from src.generate_facerender_batch import get_facerender_data
    from src.test_audio2coeff import Audio2Coeff
    from src.utils.init_path import init_path
    from src.utils.preprocess import CropAndExtract

    _patch_videoio()
    _patch_align_img()

    options = args.get("options", {})
    _patch_paste_pic(options)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    _log(f"device={device}")

    _write_progress(work_dir, "running", 10, "初始化 SadTalker 模型...")

    sadtalker_paths = init_path(
        checkpoint_dir=str(sadtalker_root / "checkpoints"),
        config_dir=str(sadtalker_root / "src" / "config"),
        size=256,
        old_version=False,
        preprocess="full",
    )

    preprocess_model = CropAndExtract(sadtalker_paths, device)
    audio_to_coeff = Audio2Coeff(sadtalker_paths, device)
    animate_from_coeff = AnimateFromCoeff(sadtalker_paths, device)

    _write_progress(work_dir, "running", 20, "提取形象 3DMM 特征...")
    first_frame_dir = work_dir / "first_frame"
    first_frame_dir.mkdir(parents=True, exist_ok=True)
    first_coeff_path, crop_pic_path, crop_info = preprocess_model.generate(
        str(source_image), str(first_frame_dir), "full", source_image_flag=True, pic_size=256
    )
    if first_coeff_path is None:
        raise RuntimeError("无法从形象图片中提取人脸特征，请换一张正面清晰的人像")

    _write_progress(work_dir, "running", 40, "根据音频生成表情系数...")
    batch = get_data(first_coeff_path, str(audio_path), device, ref_eyeblink_coeff_path=None, still=False)
    coeff_path = audio_to_coeff.generate(batch, str(work_dir), pose_style=0, ref_pose_coeff_path=None)

    _write_progress(work_dir, "running", 60, "渲染说话人脸视频...")
    data = get_facerender_data(
        coeff_path,
        crop_pic_path,
        first_coeff_path,
        str(audio_path),
        batch_size=1,
        input_yaw_list=None,
        input_pitch_list=None,
        input_roll_list=None,
        expression_scale=1.0,
        still_mode=False,
        preprocess="full",
        size=256,
    )
    result = animate_from_coeff.generate(
        data,
        str(work_dir),
        str(source_image),
        crop_info,
        enhancer=None,
        background_enhancer=None,
        preprocess="full",
        img_size=256,
    )

    _write_progress(work_dir, "running", 95, "合并音视频并保存...")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(result, str(output_path))

    _write_progress(work_dir, "done", 100, "完成", video_path=str(output_path))
    return {"video_path": str(output_path.resolve())}


def main():
    args_file = Path(sys.argv[1])
    with open(args_file, "r", encoding="utf-8") as f:
        args = json.load(f)

    work_dir = Path(args.get("work_dir"))
    try:
        result = generate(args)
        _write_progress(work_dir, "done", 100, "完成", video_path=result["video_path"])
    except Exception as e:
        error_text = f"{type(e).__name__}: {e}"
        _log(error_text)
        _log(traceback.format_exc())
        _write_progress(work_dir, "error", error=error_text)
        sys.exit(1)


if __name__ == "__main__":
    main()
