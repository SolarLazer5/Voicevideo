#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建期检查/下载 SadTalker 视频生成所需模型。"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SADTALKER_ROOT = ROOT / "github" / "SadTalker"


def _log(msg: str):
    print(f"[ensure_video_model] {msg}", flush=True)


def _setup_cache():
    """统一使用项目本地缓存，避免污染用户目录。"""
    cache = ROOT / "localdep" / "huggingface"
    os.environ.setdefault("HF_HOME", str(cache))
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(cache))


def ensure_file(repo_id: str, filename: str, local_dir: Path):
    from huggingface_hub import hf_hub_download

    local_dir.mkdir(parents=True, exist_ok=True)
    path = hf_hub_download(repo_id=repo_id, filename=filename, local_dir=str(local_dir), local_dir_use_symlinks=False)
    _log(f"ok: {path}")


def main():
    _setup_cache()

    required = {
        "vinthony/SadTalker-V002rc": [
            ("checkpoints", "SadTalker_V0.0.2_256.safetensors"),
            ("checkpoints", "mapping_00109-model.pth.tar"),
            ("checkpoints", "mapping_00229-model.pth.tar"),
        ],
        "vinthony/SadTalker": [
            ("BFM_Fitting", "01_MorphableModel.mat"),
            ("BFM_Fitting", "BFM09_model_info.mat"),
            ("BFM_Fitting", "BFM_exp_idx.mat"),
            ("BFM_Fitting", "BFM_front_idx.mat"),
            ("BFM_Fitting", "Exp_Pca.bin"),
            ("BFM_Fitting", "facemodel_info.mat"),
            ("BFM_Fitting", "select_vertex_id.mat"),
            ("BFM_Fitting", "similarity_Lm3D_all.mat"),
            ("BFM_Fitting", "std_exp.txt"),
        ],
        "leonelhs/facexlib": [
            ("gfpgan/weights", "alignment_WFLW_4HG.pth"),
            ("gfpgan/weights", "detection_Resnet50_Final.pth"),
        ],
    }

    missing = False
    for repo, files in required.items():
        for subdir, filename in files:
            target = SADTALKER_ROOT / subdir / filename
            if target.is_file():
                _log(f"already present: {target}")
                continue
            _log(f"downloading {repo}/{filename} ...")
            try:
                ensure_file(repo, f"{subdir}/{filename}" if subdir != "checkpoints" else filename, SADTALKER_ROOT / subdir)
            except Exception as e:
                _log(f"failed to download {repo}/{filename}: {e}")
                missing = True

    if missing:
        _log("some models are missing, please check network or download manually")
        sys.exit(1)
    _log("all video models are ready")


if __name__ == "__main__":
    main()
