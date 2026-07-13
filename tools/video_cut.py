#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VideoCut 后端脚本：一键 AI 网感剪辑。

用法：
    python video_cut.py <args_json_path>

args_json 示例：
{
    "video_path": "C:/.../output.mp4",
    "work_dir": "temp/video_cut/<taskid>",
    "options": {
        "enable_params": true,
        "voice_volume": 1.0,
        "bgm_volume": 1.0,
        "speed": 1.0,
        "cut_breath": true,
        "enable_subtitle": true,
        "subtitle_style": 0,
        "highlight_keywords": true,
        "enable_bgm": false,
        "bgm_path": "",
        "enable_soundfx": false
    }
}

输出：
    work_dir/output.json
    {
        "status": "done",
        "video_path": "...",
        "duration": 12.34
    }
"""

import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

# ===================== 环境初始化 =====================

def _setup_localdep():
    """优先使用 localdep 离线模型/依赖，禁止运行时联网下载。"""
    candidates = []
    if os.environ.get("VOICEVIDEO_LOCALDEP"):
        candidates.append(Path(os.environ["VOICEVIDEO_LOCALDEP"]))

    script_dir = Path(__file__).resolve().parent
    for parent in [script_dir, script_dir.parent, script_dir.parent.parent]:
        candidates.append(parent / "localdep")
        candidates.append(parent.parent / "localdep")
    candidates.append(Path.cwd() / "localdep")

    seen = set()
    for cand in candidates:
        try:
            cand = cand.resolve()
        except Exception:
            continue
        if cand in seen:
            continue
        seen.add(cand)
        if cand.is_dir():
            modelscope = cand / "modelscope"
            huggingface = cand / "huggingface"
            if modelscope.is_dir():
                os.environ.setdefault("MODELSCOPE_CACHE", str(modelscope))
            if huggingface.is_dir():
                os.environ.setdefault("HF_HOME", str(huggingface))
                os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(huggingface / "hub"))
            os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            os.environ.setdefault("MODELSCOPE_HUB_ENABLE_INFERENCE", "0")
            return


_setup_localdep()

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def log(msg: str):
    print(msg, file=sys.stderr, flush=True)


# ===================== 工具函数 =====================

def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def find_ffmpeg() -> str:
    """定位 ffmpeg。优先 localdep/tools，再 PATH。"""
    script_dir = Path(__file__).resolve().parent
    candidates = [
        script_dir.parent / "localdep" / "tools" / "ffmpeg.exe",
        Path(os.environ.get("VOICEVIDEO_LOCALDEP", "")) / "tools" / "ffmpeg.exe",
        Path.cwd() / "localdep" / "tools" / "ffmpeg.exe",
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    raise RuntimeError("未找到 ffmpeg，请将其放置到 localdep/tools/ffmpeg.exe 或加入 PATH")


def find_ffprobe() -> str:
    script_dir = Path(__file__).resolve().parent
    candidates = [
        script_dir.parent / "localdep" / "tools" / "ffprobe.exe",
        Path(os.environ.get("VOICEVIDEO_LOCALDEP", "")) / "tools" / "ffprobe.exe",
        Path.cwd() / "localdep" / "tools" / "ffprobe.exe",
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        return ffprobe
    raise RuntimeError("未找到 ffprobe")


def normalize_path(path_str: str) -> str:
    if not path_str:
        return ""
    s = path_str
    if s.startswith("file://"):
        s = s[7:]
    if s.startswith("file:///"):
        s = s[8:]
    if len(s) > 2 and s[0] == "/" and s[2] == ":":
        s = s[1:]
    s = os.path.abspath(s)
    return s.replace("\\", "/")


def load_args() -> dict:
    if len(sys.argv) < 2:
        raise RuntimeError("缺少参数文件路径")
    args_path = Path(sys.argv[1])
    if not args_path.is_file():
        raise RuntimeError(f"参数文件不存在: {args_path}")
    with open(args_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_progress_file(work_dir: Path, data: dict):
    out = work_dir / "output.json"
    tmp = work_dir / "output.json.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        tmp.replace(out)
    except Exception:
        pass


def write_progress(work_dir: Path, status: str, percent: int = 0, message: str = "",
                   video_path: str = "", error: str = "", heartbeat: float = None,
                   poster_path: str = ""):
    data = {"status": status, "percent": percent, "message": message}
    if video_path:
        data["video_path"] = video_path
    if poster_path:
        data["poster_path"] = poster_path
    if error:
        data["error"] = error
    if heartbeat is not None:
        data["heartbeat"] = heartbeat
    _write_progress_file(work_dir, data)


class ProgressTracker:
    """在耗时阶段持续刷新 output.json，避免前端认为进程卡死。"""
    def __init__(self, work_dir: Path, start: float, end: float,
                 message: str = "处理中...", interval: float = 2.0, step: float = 0.5):
        self.work_dir = work_dir
        self.percent = float(start)
        self.end = float(end)
        self.message = message
        self.interval = interval
        self.step = step
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.wait(self.interval):
            self.percent = min(self.percent + self.step, self.end)
            write_progress(self.work_dir, "running", round(self.percent, 1),
                           self.message, heartbeat=time.time())

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=1.0)


def run_cmd(cmd: list, cwd: Path = None, timeout: int = None):
    log(f"[video_cut] run: {' '.join(str(c) for c in cmd)}")
    proc = subprocess.run(
        [str(c) for c in cmd],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="ignore",
        cwd=str(cwd) if cwd else None,
        timeout=timeout,
    )
    if proc.returncode != 0:
        err = proc.stderr[-1200:] if proc.stderr else "unknown error"
        raise RuntimeError(f"命令失败 (code={proc.returncode}): {err}")
    return proc


def get_video_info(path: str) -> dict:
    ffprobe = find_ffprobe()
    cmd = [
        ffprobe, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
        "-show_entries", "format=duration",
        "-of", "json", path,
    ]
    proc = run_cmd(cmd)
    info = json.loads(proc.stdout)
    stream = (info.get("streams") or [{}])[0]
    fmt = info.get("format", {})
    width = int(stream.get("width") or 1280)
    height = int(stream.get("height") or 720)
    duration = float(fmt.get("duration") or 0) or _probe_duration_fallback(path)
    fps_str = stream.get("r_frame_rate", "30/1")
    try:
        a, b = fps_str.split("/")
        fps = float(a) / float(b)
    except Exception:
        fps = 30.0
    return {"width": width, "height": height, "duration": duration, "fps": fps}


def _probe_duration_fallback(path: str) -> float:
    ffprobe = find_ffprobe()
    cmd = [ffprobe, "-v", "error", "-show_entries", "format=duration",
           "-of", "default=noprint_wrappers=1:nokey=1", path]
    proc = run_cmd(cmd)
    try:
        return float(proc.stdout.strip())
    except Exception:
        return 0.0


def extract_audio(video_path: str, wav_path: Path):
    ffmpeg = find_ffmpeg()
    cmd = [
        ffmpeg, "-y", "-i", video_path,
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        str(wav_path),
    ]
    run_cmd(cmd)


# ===================== ASR / VAD =====================

def run_asr(wav_path: str):
    try:
        from funasr import AutoModel
    except Exception as e:
        raise RuntimeError(f"FunASR 未安装或加载失败: {e}")

    log("[video_cut] 加载 FunASR 模型...")
    model = AutoModel(
        model="paraformer-zh",
        model_revision="v2.0.4",
        vad_model="fsmn-vad",
        vad_model_revision="v2.0.4",
        punc_model="ct-punc",
        punc_model_revision="v2.0.4",
        disable_update=True,
    )
    log("[video_cut] 开始语音识别...")
    res = model.generate(input=wav_path, batch_size_s=300)
    if not res:
        return "", []
    item = res[0] if isinstance(res, list) else res
    text = str(item.get("text", "")).strip() if isinstance(item, dict) else str(item).strip()
    timestamps = item.get("timestamp", []) if isinstance(item, dict) else []

    tokens = []
    chars = list(text)
    n = min(len(chars), len(timestamps))
    for i in range(n):
        ts = timestamps[i]
        if isinstance(ts, (list, tuple)) and len(ts) >= 2:
            start_ms, end_ms = int(ts[0]), int(ts[1])
        else:
            start_ms = end_ms = int(ts)
        tokens.append({
            "text": chars[i],
            "start": start_ms / 1000.0,
            "end": end_ms / 1000.0,
        })
    # 如果时间戳比字数少，把剩余字按最后一个时间戳或平均分配
    if len(chars) > len(timestamps) and timestamps:
        last_end = timestamps[-1][1] if isinstance(timestamps[-1], (list, tuple)) else timestamps[-1]
        avg = last_end / max(1, len(timestamps))
        for i in range(len(timestamps), len(chars)):
            t = (i + 1) * avg
            tokens.append({"text": chars[i], "start": t / 1000.0, "end": (t + avg) / 1000.0})
    return text, tokens


def detect_speech_segments(audio_path: str, min_length_ms: int = 200, silence_thresh: int = -45):
    try:
        from pydub import AudioSegment
        from pydub.silence import detect_nonsilent
    except Exception as e:
        raise RuntimeError(f"pydub 未安装: {e}")

    audio = AudioSegment.from_file(audio_path)
    segments = detect_nonsilent(
        audio,
        min_silence_len=300,
        silence_thresh=silence_thresh,
        seek_step=10,
    )
    merged = []
    for s, e in segments:
        if e - s < min_length_ms:
            continue
        if merged and s - merged[-1][1] < 150:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    return [[s / 1000.0, e / 1000.0] for s, e in merged]


# ===================== 时间轴映射 =====================

def build_select_expr(segments: list) -> str:
    if not segments:
        return "1"
    parts = [f"between(t,{s:.3f},{e:.3f})" for s, e in segments]
    return "+".join(parts) if len(parts) > 1 else parts[0]


def transform_time(t_sec: float, segments: list, speed: float) -> float:
    """把原始时间映射到剪辑/变速后的最终时间。"""
    if not segments:
        return t_sec / speed
    offset = 0.0
    for s, e in segments:
        if s <= t_sec <= e:
            return offset + (t_sec - s) / speed
        elif t_sec < s:
            return offset
        else:
            offset += (e - s) / speed
    return offset


def final_duration(segments: list, speed: float, original_duration: float) -> float:
    if not segments:
        total = original_duration
    else:
        total = sum(e - s for s, e in segments)
    return total / speed


# ===================== 字幕 =====================

HIGHLIGHT_KEYWORDS = [
    "优惠", "折扣", "福利", "免费", "爆款", "火爆", "震惊", "紧急",
    "注意", "成功", "赚钱", "开心", "快乐", "喜欢", "爱", "必看",
    "限时", "秒杀", "立省", "省钱",
]

SUBTITLE_STYLES = [
    {
        "name": "经典白字黑边",
        "fontname": "Microsoft YaHei",
        "fontsize": 0.05,
        "primary": "&HFFFFFF&",
        "secondary": "&HFFFFFF&",
        "outline": "&H000000&",
        "back": "&H000000&",
        "bold": 1,
        "outline_size": 2.5,
        "shadow": 1,
        "alignment": 2,
    },
    {
        "name": "黄白高亮",
        "fontname": "Microsoft YaHei",
        "fontsize": 0.055,
        "primary": "&H00E7FF&",
        "secondary": "&H00E7FF&",
        "outline": "&H000000&",
        "back": "&H000000&",
        "bold": 1,
        "outline_size": 2.5,
        "shadow": 1,
        "alignment": 2,
    },
    {
        "name": "抖音大字",
        "fontname": "Microsoft YaHei",
        "fontsize": 0.07,
        "primary": "&HFFFFFF&",
        "secondary": "&HFFFFFF&",
        "outline": "&H000000&",
        "back": "&H000000&",
        "bold": 1,
        "outline_size": 3.5,
        "shadow": 2,
        "alignment": 2,
    },
    {
        "name": "小红书粉",
        "fontname": "Microsoft YaHei",
        "fontsize": 0.055,
        "primary": "&H8A9BFF&",
        "secondary": "&H8A9BFF&",
        "outline": "&HFFFFFF&",
        "back": "&H000000&",
        "bold": 1,
        "outline_size": 2,
        "shadow": 1,
        "alignment": 2,
    },
    {
        "name": "网感粗体",
        "fontname": "Microsoft YaHei",
        "fontsize": 0.065,
        "primary": "&HFFFFFF&",
        "secondary": "&HFFFFFF&",
        "outline": "&H1A1A1A&",
        "back": "&H1A1A1A&",
        "bold": 1,
        "outline_size": 3,
        "shadow": 2,
        "alignment": 2,
    },
    {
        "name": "科技蓝",
        "fontname": "Microsoft YaHei",
        "fontsize": 0.055,
        "primary": "&HFFE7A1&",
        "secondary": "&HFFE7A1&",
        "outline": "&H000000&",
        "back": "&H000000&",
        "bold": 1,
        "outline_size": 2,
        "shadow": 1,
        "alignment": 2,
    },
    {
        "name": "活力橙",
        "fontname": "Microsoft YaHei",
        "fontsize": 0.06,
        "primary": "&H00B4FF&",
        "secondary": "&H00B4FF&",
        "outline": "&HFFFFFF&",
        "back": "&H000000&",
        "bold": 1,
        "outline_size": 2.5,
        "shadow": 1,
        "alignment": 2,
    },
    {
        "name": "极简细线",
        "fontname": "Microsoft YaHei",
        "fontsize": 0.05,
        "primary": "&HFFFFFF&",
        "secondary": "&HFFFFFF&",
        "outline": "&H000000&",
        "back": "&H000000&",
        "bold": 0,
        "outline_size": 1.5,
        "shadow": 0,
        "alignment": 2,
    },
]


def build_subtitle_lines(tokens: list, segments: list, speed: float,
                         subtitle_style: int = 0, max_chars: int = 12,
                         highlight: bool = True) -> list:
    """把字级 token 分句成字幕行，并做时间轴映射。"""
    lines = []
    if not tokens:
        return lines

    buffer = []
    def flush():
        if not buffer:
            return
        text = "".join(t["text"] for t in buffer)
        start_orig = buffer[0]["start"]
        end_orig = buffer[-1]["end"]
        start_final = transform_time(start_orig, segments, speed)
        end_final = transform_time(end_orig, segments, speed)
        if end_final <= start_final:
            end_final = start_final + 1.0
        if highlight:
            text = apply_highlight(text, SUBTITLE_STYLES[subtitle_style % len(SUBTITLE_STYLES)]["primary"])
        lines.append({
            "text": text,
            "start": start_final,
            "end": end_final,
        })
        buffer.clear()

    punct = set("，。！？；,.!?;")
    for tok in tokens:
        buffer.append(tok)
        if tok["text"] in punct or len(buffer) >= max_chars:
            flush()
    flush()
    return lines


def apply_highlight(text: str, reset_color: str) -> str:
    highlight_tag = r"{\c&H0000FF&}"
    reset_tag = r"{\c" + reset_color + "}"
    out = text
    for kw in HIGHLIGHT_KEYWORDS:
        if kw in out:
            # 避免对已经加标签的文本重复处理导致混乱：先去掉已有标签再替换
            out = out.replace(kw, f"{highlight_tag}{kw}{reset_tag}")
    return out


def ass_time(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    cs = int(round((sec % 1) * 100))
    if cs >= 100:
        cs = 99
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def write_ass(path: Path, style_index: int, width: int, height: int, lines: list):
    style = SUBTITLE_STYLES[style_index % len(SUBTITLE_STYLES)]
    fontsize = max(18, int(height * style["fontsize"]))
    outline = max(1, round(height * 0.004 * style["outline_size"], 1))
    shadow = max(0, round(height * 0.002 * style["shadow"], 1))
    margin_v = int(height * 0.12)

    header = f"""[Script Info]
Title: Voicevideo Subtitle
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{style['fontname']},{fontsize},{style['primary']},{style['secondary']},{style['outline']},{style['back']},{style['bold']},0,0,0,100,100,0,0,1,{outline},{shadow},{style['alignment']},20,20,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    for i, line in enumerate(lines):
        events.append(
            f"Dialogue: 0,{ass_time(line['start'])},{ass_time(line['end'])},Default,,0,0,0,,{line['text']}"
        )
    with open(path, "w", encoding="utf-8") as f:
        f.write(header)
        f.write("\n".join(events))
        f.write("\n")


# ===================== 音效 =====================

def get_sfx_index() -> dict:
    """加载或生成音效关键词索引。"""
    script_dir = Path(__file__).resolve().parent
    localdep_sfx = script_dir.parent / "localdep" / "sfx"
    index_file = localdep_sfx / "sfx_index.json"
    if index_file.is_file():
        try:
            with open(index_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return build_sfx_index(localdep_sfx)


def build_sfx_index(sfx_dir: Path) -> dict:
    """扫描 sfx 目录并建立关键词→文件列表的索引。"""
    keyword_map = {
        "success": ["成功", "完成", "胜利", "通过", "搞定"],
        "coin": ["金币", "奖励", "优惠", "折扣", "福利", "免费", "省钱", "立省"],
        "click": ["点击", "选择", "开启", "打开", "按下"],
        "alert": ["注意", "紧急", "警告", "提醒", "重要"],
        "magic": ["惊喜", "魔法", "特效", "神奇", "炫酷"],
        "explosion": ["爆炸", "震惊", "火爆", "爆款", "燃"],
    }
    index = {k: [] for k in keyword_map}
    if not sfx_dir.is_dir():
        return index
    for root, _, files in os.walk(sfx_dir):
        for fname in files:
            low = fname.lower()
            if not low.endswith((".wav", ".mp3", ".ogg", ".m4a", ".flac")):
                continue
            fpath = str(Path(root) / fname).replace("\\", "/")
            stem = Path(fname).stem.lower()
            for key, aliases in keyword_map.items():
                if key in stem or any(alias in stem for alias in aliases):
                    index[key].append(fpath)
    return index


def match_sfx_events(tokens: list, segments: list, speed: float, index: dict) -> list:
    events = []
    if not index or not tokens:
        return events

    # 合并 token 为字符串并记录每个字符的起始时间
    text = "".join(t["text"] for t in tokens)
    starts = [t["start"] for t in tokens]

    used_files = set()
    last_time = -2.5

    # 关键词匹配，按优先级
    priority = ["explosion", "coin", "success", "alert", "magic", "click"]
    for key in priority:
        files = index.get(key, [])
        if not files:
            continue
        for kw in list(set([key] + [])):
            pass
        # 按中文关键词列表匹配
        kw_list = list(set([key] + []))
        # 从 index 的构建逻辑中拿不到中文别名，这里用常见词根做兜底
        extra = {
            "explosion": ["爆炸", "震惊", "火爆", "爆款", "燃"],
            "coin": ["金币", "奖励", "优惠", "折扣", "福利", "免费", "省钱"],
            "success": ["成功", "完成", "胜利", "通过", "搞定"],
            "alert": ["注意", "紧急", "警告", "提醒", "重要"],
            "magic": ["惊喜", "魔法", "特效", "神奇", "炫酷"],
            "click": ["点击", "选择", "开启", "打开"],
        }.get(key, [])
        for kw in extra:
            pos = text.find(kw)
            while pos != -1:
                t_orig = starts[pos] if pos < len(starts) else 0.0
                t_final = transform_time(t_orig, segments, speed)
                if t_final - last_time >= 2.0:
                    # 选一个未用过的文件，否则轮询
                    fpath = None
                    for fp in files:
                        if fp not in used_files or len(used_files) >= len(files):
                            fpath = fp
                            used_files.add(fp)
                            break
                    if fpath:
                        events.append({"time_ms": int(t_final * 1000), "file": fpath})
                        last_time = t_final
                pos = text.find(kw, pos + 1)
    return events


# ===================== 音频/视频处理 =====================

def build_main_audio(video_path: str, segments: list, speed: float,
                     volume: float, output_path: Path):
    ffmpeg = find_ffmpeg()
    expr = build_select_expr(segments)
    # atempo 只支持 0.5~2.0，UI 已限制在此区间
    atempo = max(0.5, min(2.0, speed))
    filter_str = (
        f"[0:a]aselect='{expr}',asetpts=N/SR/TB,"
        f"atempo={atempo:.3f},volume={volume:.2f}[aout]"
    )
    cmd = [
        ffmpeg, "-y", "-i", video_path,
        "-filter_complex", filter_str,
        "-map", "[aout]", "-vn",
        "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2",
        str(output_path),
    ]
    run_cmd(cmd)


def build_processed_video(video_path: str, segments: list, speed: float,
                          ass_path: Path, info: dict, output_path: Path, work_dir: Path):
    ffmpeg = find_ffmpeg()
    expr = build_select_expr(segments)
    # setpts 分两步：先重置为帧计数时间，再按倍速缩放
    vf = f"select='{expr}',setpts=N/FRAME_RATE/TB,setpts=PTS/{speed:.3f}"
    if ass_path and ass_path.is_file():
        # ffmpeg 在工作目录执行，ASS 使用相对路径避免 Windows 冒号问题
        vf += ",subtitles='subtitle.ass'"
    cmd = [
        ffmpeg, "-y", "-i", video_path,
        "-vf", vf,
        "-an",
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-pix_fmt", "yuv420p",
        str(output_path),
    ]
    run_cmd(cmd, cwd=work_dir)


def mix_audio(main_path: Path, overlay_path: Path, output_path: Path):
    ffmpeg = find_ffmpeg()
    cmd = [
        ffmpeg, "-y", "-i", str(main_path), "-i", str(overlay_path),
        "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=3[aout]",
        "-map", "[aout]",
        "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2",
        str(output_path),
    ]
    run_cmd(cmd)


def loop_with_crossfade(segment, duration_ms: int, fade_ms: int = 500):
    """把一段 BGM 循环铺满指定时长，并在接缝处加淡入淡出，避免生硬重复。"""
    seg_len = len(segment)
    if seg_len >= duration_ms:
        return segment[:duration_ms]
    fade_ms = min(fade_ms, seg_len // 4)
    loops = math.ceil(duration_ms / max(1, seg_len - fade_ms))
    result = segment.fade_out(fade_ms)
    for _ in range(1, loops):
        result = result.overlay(segment, position=len(result) - seg_len)
    return result[:duration_ms]


def create_overlay_audio(duration_ms: int, bgm_path: str, bgm_volume: float,
                         sfx_events: list, work_dir: Path) -> Path:
    try:
        from pydub import AudioSegment
    except Exception as e:
        raise RuntimeError(f"pydub 未安装: {e}")

    ffmpeg = find_ffmpeg()
    AudioSegment.converter = ffmpeg

    base = AudioSegment.silent(duration=duration_ms)

    # BGM 统一做“ behind voice ”处理：大幅压低音量 + 高通滤波，避免与人声频段打架产生“回声/浑浊”
    BGM_DUCK_DB = -18.0
    BGM_HP_HZ = 200

    if bgm_path and os.path.isfile(bgm_path):
        try:
            bgm = AudioSegment.from_file(bgm_path)
            bgm = bgm.high_pass_filter(BGM_HP_HZ)
            gain = BGM_DUCK_DB
            if bgm_volume > 0:
                gain += 20 * math.log10(bgm_volume)
            bgm = bgm.apply_gain(gain)
            if len(bgm) < duration_ms:
                bgm = loop_with_crossfade(bgm, duration_ms)
            else:
                bgm = bgm[:duration_ms]
            base = base.overlay(bgm, position=0)
            log(f"[video_cut] BGM mixed: gain={gain:.1f}dB, duration={len(bgm)}ms")
        except Exception as e:
            log(f"[video_cut] BGM 处理失败: {e}")

    for ev in sfx_events:
        try:
            fx = AudioSegment.from_file(ev["file"])
            # 避免音效过长盖住人声，做短淡入淡出并降音量
            fx = fx - 8
            if len(fx) > 1500:
                fx = fx[:1500].fade_out(300)
            pos = max(0, ev["time_ms"])
            if pos < duration_ms:
                base = base.overlay(fx, position=pos)
        except Exception as e:
            log(f"[video_cut] 音效叠加失败: {e}")

    out = work_dir / "overlay.wav"
    base.export(out, format="wav")
    return out


def mux_video_audio(video_path: Path, audio_path: Path, output_path: Path):
    ffmpeg = find_ffmpeg()
    cmd = [
        ffmpeg, "-y", "-i", str(video_path), "-i", str(audio_path),
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k",
        "-map", "0:v:0", "-map", "1:a:0",
        "-shortest",
        str(output_path),
    ]
    run_cmd(cmd)


def extract_first_frame(video_path: Path, output_path: Path):
    """截取视频第一帧作为预览封面。"""
    ffmpeg = find_ffmpeg()
    cmd = [
        ffmpeg, "-y", "-i", str(video_path),
        "-ss", "00:00:00",
        "-vframes", "1",
        "-q:v", "2",
        str(output_path),
    ]
    run_cmd(cmd)


# ===================== 主流程 =====================

def main():
    work_dir = None
    try:
        args = load_args()
        work_dir = Path(args.get("work_dir") or (Path(__file__).parent.parent / "temp" / "video_cut" / "job")).resolve()
        ensure_dir(work_dir)

        video_path = normalize_path(args.get("video_path", ""))
        if not video_path or not os.path.isfile(video_path):
            raise RuntimeError(f"视频文件不存在: {video_path}")

        options = args.get("options", {})
        enable_params = options.get("enable_params", True)
        enable_subtitle = options.get("enable_subtitle", True)
        enable_bgm = options.get("enable_bgm", False)
        enable_soundfx = options.get("enable_soundfx", False)

        speed = float(options.get("speed", 1.0))
        speed = max(0.5, min(2.0, speed))
        voice_volume = float(options.get("voice_volume", 1.0))
        bgm_volume = float(options.get("bgm_volume", 1.0))
        cut_breath = options.get("cut_breath", True)
        subtitle_style = int(options.get("subtitle_style", 0))
        highlight = options.get("highlight_keywords", True)
        bgm_path = normalize_path(options.get("bgm_path", ""))

        if not enable_params:
            speed = 1.0
            voice_volume = 1.0
            cut_breath = False

        # 让开关状态真正生效：BGM 没有有效路径时强制关闭
        features = []
        if enable_params:
            features.append("音视频参数")
        if enable_subtitle:
            features.append("字幕")
        if enable_bgm:
            if bgm_path and os.path.isfile(bgm_path):
                features.append("BGM")
            else:
                enable_bgm = False
                log("[video_cut] BGM 开关已打开但未选择有效 BGM 文件，已忽略")
        if enable_soundfx:
            features.append("音效")
        feature_msg = "已开启：" + " / ".join(features) if features else "未开启任何特效"
        log(f"[video_cut] {feature_msg}")

        write_progress(work_dir, "running", 5, f"正在读取视频信息... {feature_msg}")
        info = get_video_info(video_path)
        log(f"[video_cut] video info: {info}")

        audio_wav = work_dir / "audio.wav"
        extract_audio(video_path, audio_wav)
        log(f"[video_cut] audio extracted: {audio_wav}")

        need_asr = enable_subtitle or enable_soundfx or cut_breath
        tokens = []
        full_text = ""
        segments = []

        if need_asr:
            tracker = ProgressTracker(
                work_dir, start=15, end=24,
                message="正在语音识别，首次加载模型可能较慢...",
                interval=2.0, step=0.6,
            )
            tracker.start()
            try:
                full_text, tokens = run_asr(str(audio_wav))
            finally:
                tracker.stop()
            write_progress(work_dir, "running", 25, "语音识别完成")
            log(f"[video_cut] ASR text({len(full_text)}): {full_text[:80]}")

        if cut_breath:
            write_progress(work_dir, "running", 25, "正在检测气口...")
            segments = detect_speech_segments(str(audio_wav))
            if not segments:
                segments = [[0.0, info["duration"]]]
            log(f"[video_cut] speech segments: {segments}")
        else:
            segments = [[0.0, info["duration"]]]

        duration_final = final_duration(segments, speed, info["duration"])
        duration_ms = int(duration_final * 1000)

        # 音效匹配
        sfx_events = []
        if enable_soundfx:
            write_progress(work_dir, "running", 30, "正在匹配 AI 音效...")
            index = get_sfx_index()
            sfx_events = match_sfx_events(tokens, segments, speed, index)
            log(f"[video_cut] sfx events: {len(sfx_events)}")

        # 处理主音频
        write_progress(work_dir, "running", 40, "正在处理人声音频...")
        main_audio = work_dir / "main_audio.wav"
        build_main_audio(
            video_path, segments,
            speed, voice_volume if enable_params else 1.0,
            main_audio,
        )

        # 背景音乐与音效叠加轨
        overlay_audio = None
        if (enable_bgm and bgm_path and os.path.isfile(bgm_path)) or sfx_events:
            write_progress(work_dir, "running", 55, "正在合成背景音乐与音效...")
            overlay_audio = create_overlay_audio(
                duration_ms,
                bgm_path if (enable_bgm and bgm_path) else None,
                bgm_volume if enable_bgm else 0.0,
                sfx_events,
                work_dir,
            )

        final_audio = work_dir / "final_audio.wav"
        if overlay_audio:
            mix_audio(main_audio, overlay_audio, final_audio)
        else:
            final_audio = main_audio

        # 生成字幕
        ass_path = None
        if enable_subtitle and tokens:
            write_progress(work_dir, "running", 65, "正在生成字幕...")
            lines = build_subtitle_lines(tokens, segments, speed, subtitle_style=subtitle_style, highlight=highlight)
            ass_path = work_dir / "subtitle.ass"
            write_ass(ass_path, subtitle_style, info["width"], info["height"], lines)
            log(f"[video_cut] subtitle lines: {len(lines)}")

        # 处理视频画面
        write_progress(work_dir, "running", 75, "正在处理视频画面...")
        processed_video = work_dir / "processed_video.mp4"
        build_processed_video(
            video_path, segments,
            speed,
            ass_path if enable_subtitle else None,
            info,
            processed_video,
            work_dir,
        )

        # 封装
        write_progress(work_dir, "running", 90, "正在封装最终视频...")
        output_path = work_dir / "output.mp4"
        mux_video_audio(processed_video, final_audio, output_path)

        if not output_path.is_file():
            raise RuntimeError("最终视频文件未生成")

        poster_path = work_dir / "poster.jpg"
        try:
            extract_first_frame(output_path, poster_path)
            log(f"[video_cut] poster: {poster_path}")
        except Exception as e:
            log(f"[video_cut] 封面提取失败: {e}")
            poster_path = None

        write_progress(
            work_dir, "done", 100,
            message="剪辑完成",
            video_path=str(output_path).replace("\\", "/"),
            poster_path=str(poster_path).replace("\\", "/") if poster_path and poster_path.is_file() else "",
        )
        log(f"[video_cut] output: {output_path}")

    except Exception as e:
        err = traceback.format_exc()
        log(err)
        if work_dir:
            write_progress(work_dir, "error", 0, error=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
