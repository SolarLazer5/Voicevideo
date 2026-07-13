#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Video generation backend (cloud): portrait image + audio -> talking-head MP4
via Alibaba Cloud DashScope wan2.2-s2v.

Flow:
    1. upload image to temporary OSS and run wan2.2-s2v-detect
    2. slice audio into <=20 s chunks (wan2.2-s2v audio limit)
    3. for each chunk: upload audio, submit wan2.2-s2v async task, poll, download
    4. concatenate all chunk videos with ffmpeg
"""
import json
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path

import requests
from PIL import Image
from pydub import AudioSegment

DASHSCOPE_HOST = "dashscope.aliyuncs.com"
DASHSCOPE_BASE = f"https://{DASHSCOPE_HOST}/api/v1"
POLICY_MODEL = "qwen-vl-plus"  # only used to obtain temporary OSS credential
MAX_AUDIO_SECONDS = 20  # wan2.2-s2v per-task audio limit


def _reconfigure_stdio():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def _log(msg: str):
    print(f"[video_cloud] {msg}", flush=True, file=sys.stderr)


def _sanitize_body_for_log(body):
    """脱敏日志：仅隐藏可能的 API Key，保留 URL 便于调试。"""
    if not isinstance(body, dict):
        return body
    out = dict(body)
    for k in ("api_key", "Authorization", "authorization"):
        if k in out:
            out[k] = "***"
    return out


class DashScopeError(Exception):
    """DashScope / OSS returned an error payload."""

    def __init__(self, payload: dict, message: str = ""):
        self.payload = payload or {}
        super().__init__(message or str(self.payload))


class BalanceExhaustedError(Exception):
    """账户额度耗尽，但此前已有部分片段生成成功。"""

    def __init__(self, completed_seconds: float, completed_segments: int):
        self.completed_seconds = completed_seconds
        self.completed_segments = completed_segments
        super().__init__(f"额度不足，已生成 {completed_segments} 段约 {completed_seconds:.1f} 秒")


def _write_progress(
    work_dir: Path,
    status: str,
    percent: int = 0,
    message: str = "",
    video_path: str = "",
    error: str = "",
    error_code: str = "",
    warning: str = "",
    partial: bool = False,
):
    payload = {
        "status": status,
        "progress": {"percent": percent, "message": message},
    }
    if video_path:
        payload["video_path"] = str(video_path)
    if error:
        payload["error"] = str(error)
    if error_code:
        payload["error_code"] = str(error_code)
    if warning:
        payload["warning"] = str(warning)
    if partial:
        payload["partial"] = True
    try:
        out = work_dir / "output.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
    except Exception as e:
        _log(f"failed to write progress: {e}")


def _load_args():
    if len(sys.argv) < 2:
        raise RuntimeError("缺少 args.json 参数")
    args_path = Path(sys.argv[1])
    with open(args_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _find_tool(name: str) -> Path:
    """优先使用 localdep/tools 下的 ffmpeg/ffprobe，否则回退 PATH。"""
    localdep = os.environ.get("VOICEVIDEO_LOCALDEP", "")
    if localdep:
        p = Path(localdep) / "tools" / f"{name}.exe"
        if p.is_file():
            return p
        p = Path(localdep) / "tools" / name
        if p.is_file():
            return p
    script_dir = Path(__file__).resolve().parent
    for rel in ("../localdep/tools", "../../localdep/tools"):
        p = (script_dir / rel / f"{name}.exe").resolve()
        if p.is_file():
            return p
    return Path(name)


def _setup_audio():
    ffmpeg = _find_tool("ffmpeg")
    ffprobe = _find_tool("ffprobe")
    AudioSegment.converter = str(ffmpeg)
    AudioSegment.ffprobe = str(ffprobe)
    return ffmpeg, ffprobe


def _api_call(
    method: str,
    url: str,
    api_key: str,
    json_body: dict | None = None,
    extra_headers: dict | None = None,
    timeout: int = 60,
    data=None,
    files=None,
) -> dict:
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    headers["Content-Type"] = "application/json"
    if extra_headers:
        headers.update(extra_headers)
    method = method.upper()
    _log(f"API {method} {url}")
    if json_body is not None:
        _log(f"API body: {json.dumps(_sanitize_body_for_log(json_body), ensure_ascii=False)}")
    if method == "GET":
        resp = requests.get(url, headers=headers, timeout=timeout)
    else:
        if files is not None:
            headers.pop("Content-Type", None)
        resp = requests.post(
            url, headers=headers, json=json_body, data=data, files=files, timeout=timeout
        )
    _log(f"API response status: {resp.status_code}")
    if not resp.ok:
        try:
            err = resp.json()
        except Exception:
            err = {"message": resp.text[:500], "code": f"HTTP_{resp.status_code}"}
        _log(f"API error response: {json.dumps(err, ensure_ascii=False)}")
        raise DashScopeError(err)
    try:
        result = resp.json()
        _log(f"API response body: {json.dumps(_sanitize_body_for_log(result), ensure_ascii=False)}")
        return result
    except Exception as e:
        raise DashScopeError({"message": f"invalid json response: {e}"})


def _get_upload_policy(api_key: str, model: str = POLICY_MODEL) -> dict:
    url = f"{DASHSCOPE_BASE}/uploads?action=getPolicy&model={model}"
    resp = _api_call(
        "GET",
        url,
        api_key,
        extra_headers={"Content-Type": "application/json"},
        timeout=30,
    )
    data = resp.get("data") if isinstance(resp, dict) else None
    if not isinstance(data, dict):
        raise DashScopeError({"message": f"getPolicy 返回异常: {resp}"})
    return data


def _upload_file_to_oss(policy: dict, file_path: Path) -> str:
    upload_dir = (policy.get("upload_dir") or "").rstrip("/")
    key = f"{upload_dir}/{file_path.name}" if upload_dir else file_path.name
    fields = {
        "OSSAccessKeyId": policy["oss_access_key_id"],
        "Signature": policy["signature"],
        "policy": policy["policy"],
        "key": key,
        "success_action_status": "200",
    }
    for opt in ("x_oss_object_acl", "x_oss_forbid_overwrite", "x_oss_security_token"):
        val = policy.get(opt)
        if val:
            fields[opt.replace("_", "-")] = val
    with open(file_path, "rb") as f:
        files = {"file": (file_path.name, f, "application/octet-stream")}
        upload_url = policy["upload_host"]
        _log(f"API POST {upload_url}")
        resp = requests.post(upload_url, data=fields, files=files, timeout=180)
        _log(f"API response status: {resp.status_code}")
        if not resp.ok:
            text = resp.text[:500]
            _log(f"OSS upload error: {text}")
            raise DashScopeError({"message": f"OSS 上传失败: {text}"})
    return f"oss://{key}"


def _prepare_image(src_path: Path, work_dir: Path) -> Path:
    """转换为 RGB JPEG，保持原比例，最小边 >= 400，最大边 <= 4096。"""
    img = Image.open(src_path)
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    w, h = img.size
    min_side = min(w, h)
    max_side = max(w, h)
    # wan2.2-s2v-detect requires min side >= 400
    if min_side < 400:
        ratio = 400 / min_side
        w, h = int(w * ratio), int(h * ratio)
        img = img.resize((w, h), Image.Resampling.LANCZOS)
    if max_side > 4096:
        ratio = 4096 / max_side
        w, h = int(w * ratio), int(h * ratio)
        img = img.resize((w, h), Image.Resampling.LANCZOS)
    out = work_dir / "source_image.jpg"
    img.save(out, "JPEG", quality=95)
    return out


def _prepare_audio(src_path: Path, work_dir: Path) -> Path:
    """统一转成 MP3，避免格式兼容问题。"""
    audio = AudioSegment.from_file(str(src_path))
    out = work_dir / "source_audio.mp3"
    audio.export(str(out), format="mp3", bitrate="128k")
    return out


def _slice_audio(audio_path: Path, work_dir: Path) -> list[tuple[Path, float]]:
    audio = AudioSegment.from_file(str(audio_path))
    chunks: list[tuple[Path, float]] = []
    duration_ms = len(audio)
    chunk_ms = MAX_AUDIO_SECONDS * 1000
    for idx, start in enumerate(range(0, duration_ms, chunk_ms)):
        end = min(start + chunk_ms, duration_ms)
        chunk = audio[start:end]
        chunk_path = work_dir / f"chunk_{idx:03d}.mp3"
        chunk.export(str(chunk_path), format="mp3", bitrate="128k")
        chunks.append((chunk_path, len(chunk) / 1000.0))
    return chunks


def _detect_image(api_key: str, image_oss_url: str) -> None:
    url = f"{DASHSCOPE_BASE}/services/aigc/image2video/face-detect"
    body = {
        "model": "wan2.2-s2v-detect",
        "input": {"image_url": image_oss_url},
    }
    resp = _api_call(
        "POST",
        url,
        api_key,
        json_body=body,
        extra_headers={
            "X-DashScope-OssResourceResolve": "enable",
        },
        timeout=60,
    )
    output = resp.get("output", {}) if isinstance(resp, dict) else {}
    if not output.get("check_pass", False):
        msg = output.get("message") or "图片未通过检测"
        raise DashScopeError({"code": "InvalidInput", "message": msg})


def _submit_video(
    api_key: str,
    image_oss_url: str,
    audio_oss_url: str,
    style: str = "speech",
    resolution: str = "480P",
) -> str:
    url = f"{DASHSCOPE_BASE}/services/aigc/image2video/video-synthesis/"
    body = {
        "model": "wan2.2-s2v",
        "input": {
            "image_url": image_oss_url,
            "audio_url": audio_oss_url,
        },
        "parameters": {
            "style": style,
            "resolution": resolution,
        },
    }
    resp = _api_call(
        "POST",
        url,
        api_key,
        json_body=body,
        extra_headers={
            "X-DashScope-Async": "enable",
            "X-DashScope-OssResourceResolve": "enable",
        },
        timeout=60,
    )
    output = resp.get("output", {}) if isinstance(resp, dict) else {}
    task_id = output.get("task_id")
    if not task_id:
        raise DashScopeError({"message": "提交任务未返回 task_id"})
    return task_id


def _poll_task(api_key: str, task_id: str, timeout: int = 3600) -> dict:
    url = f"{DASHSCOPE_BASE}/tasks/{task_id}"
    start = time.time()
    while True:
        resp = _api_call("GET", url, api_key, timeout=60)
        output = resp.get("output", {}) if isinstance(resp, dict) else {}
        status = output.get("task_status")
        _log(f"task {task_id} status={status}")
        if status in ("SUCCEEDED", "FAILED", "UNKNOWN"):
            return resp
        if time.time() - start > timeout:
            raise TimeoutError(f"轮询任务 {task_id} 超时")
        time.sleep(5)


def _download_video(url: str, output_path: Path):
    _log(f"downloading video from {url}")
    resp = requests.get(url, timeout=300)
    resp.raise_for_status()
    output_path.write_bytes(resp.content)


def _concat_videos(ffmpeg: Path, segment_paths: list[Path], output_path: Path):
    if len(segment_paths) == 1:
        subprocess.run([str(ffmpeg), "-y", "-i", str(segment_paths[0]), "-c", "copy", str(output_path)],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return
    concat_file = output_path.parent / "concat_list.txt"
    with open(concat_file, "w", encoding="utf-8") as f:
        for p in segment_paths:
            f.write(f"file '{p.resolve()}'\n")
    subprocess.run(
        [str(ffmpeg), "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(output_path)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def _try_write_partial(
    work_dir: Path,
    ffmpeg: Path,
    segment_paths: list[Path],
    completed_seconds: float,
    resolution: str,
) -> bool:
    """尝试把已生成片段拼接为 partial_output.mp4 并写入 done 进度。"""
    if not segment_paths:
        return False
    try:
        partial_path = work_dir / "partial_output.mp4"
        _concat_videos(ffmpeg, segment_paths, partial_path)
        if partial_path.is_file() and partial_path.stat().st_size > 0:
            price = 0.9 if resolution == "720P" else 0.5
            consumed = completed_seconds * price
            warning = (
                f"账户额度不足，仅生成前 {len(segment_paths)} 段（约 {completed_seconds:.1f} 秒），"
                f"已产生约 {consumed:.2f} 元费用，后续片段无法继续生成。"
            )
            _write_progress(
                work_dir,
                "done",
                100,
                "完成",
                video_path=str(partial_path.resolve()),
                warning=warning,
                partial=True,
            )
            return True
    except Exception as concat_err:
        _log(f"partial concat failed: {concat_err}")
    return False


def _classify_error(exc: Exception, task_status_msg: str | None = None) -> tuple[str, str]:
    exc_text = str(exc).lower()
    status_msg = (task_status_msg or "").lower()
    payload: dict = {}
    if isinstance(exc, DashScopeError):
        payload = exc.payload or {}
    elif isinstance(exc, requests.exceptions.HTTPError):
        try:
            payload = exc.response.json() if exc.response is not None else {}
        except Exception:
            if exc.response is not None:
                payload = {"message": exc.response.text[:500], "code": f"HTTP_{exc.response.status_code}"}

    code = payload.get("code") or ""
    message = (payload.get("message") or "").lower()

    if isinstance(exc, requests.exceptions.ConnectionError) or "connection" in exc_text:
        return "NETWORK_ERROR", "无法连接到阿里云百炼服务器，请检查网络"
    if isinstance(exc, requests.exceptions.Timeout) or isinstance(exc, TimeoutError) or "timeout" in exc_text:
        return "NETWORK_ERROR", "连接阿里云百炼服务器超时，请检查网络后重试"

    if "401" in exc_text or code in ("InvalidApiKey", "invalid_api_key", "AccessDenied"):
        return "AUTH_FAILED", "API Key 无效或已过期，请检查设置"

    if code in ("InsufficientBalance", "QuotaExhausted", "Arrearage") or "余额" in message or "额度" in message or "insufficient" in message or "quota" in message or "arrearage" in message or "good standing" in message:
        return "INSUFFICIENT_BALANCE", "阿里云百炼账户额度不足，请前往控制台充值"

    if code in ("ContentModeration", "ImageContentViolation") or "不合规" in message or "审核" in message:
        return "CONTENT_MODERATION", "内容审核未通过，请更换形象或音频"

    if code == "InvalidURL" and ("audio" in message or "longer than" in message):
        return "INVALID_INPUT", f"音频超过单次限制（{MAX_AUDIO_SECONDS} 秒），已自动切片但拼接失败：{payload.get('message') or task_status_msg}"

    if code in ("InvalidInput", "InvalidFile.Resolution", "InvalidURL") or code.startswith("InvalidFile.") or "图片未通过检测" in str(exc) or "未通过检测" in message:
        return "INVALID_INPUT", f"输入不符合要求：{payload.get('message') or task_status_msg or '请检查图片/音频或风格/分辨率设置'}"

    if code in ("InvalidParameter",) or "parameters is in a wrong format" in message:
        return "INVALID_INPUT", f"请求参数错误：{payload.get('message') or task_status_msg or '请检查图片/音频或风格/分辨率设置'}"

    if code == "ModelUnavailable":
        return "TASK_FAILED", "阿里云百炼服务暂时不可用，请稍后重试"

    if task_status_msg:
        return "TASK_FAILED", f"云端生成失败：{task_status_msg}"
    if message:
        return "TASK_FAILED", f"云端返回错误：{payload.get('message') or message}"

    return "UNKNOWN_ERROR", f"未知错误：{exc}"


def main():
    _reconfigure_stdio()
    _log(f"wan2.2-s2v cloud generator started, base={DASHSCOPE_BASE}")

    try:
        args = _load_args()
    except Exception as e:
        _log(f"参数读取失败: {e}")
        return 1

    work_dir = Path(args["work_dir"])
    source_image = Path(args["source_image"])
    audio_path = Path(args["audio_path"])
    output_path = Path(args.get("output_path", work_dir / "output.mp4"))
    style = args.get("style") or "speech"
    resolution = args.get("resolution") or "480P"
    if style not in ("speech", "singing", "performance"):
        style = "speech"
    if resolution not in ("480P", "720P"):
        resolution = "480P"

    if not source_image.is_file():
        _write_progress(work_dir, "error", error=f"形象图片不存在: {source_image}", error_code="INVALID_INPUT")
        return 1
    if not audio_path.is_file():
        _write_progress(work_dir, "error", error=f"驱动音频不存在: {audio_path}", error_code="INVALID_INPUT")
        return 1

    api_key = os.environ.get("DASHSCOPE_API_KEY") or ""
    if not api_key:
        _write_progress(
            work_dir,
            "error",
            error="未设置 DASHSCOPE_API_KEY，请先在设置中填写阿里云百炼 API Key",
            error_code="AUTH_FAILED",
        )
        return 1

    try:
        ffmpeg, _ffprobe = _setup_audio()
    except Exception as e:
        _write_progress(work_dir, "error", error=f"找不到 ffmpeg: {e}", error_code="INVALID_INPUT")
        return 1

    try:
        _write_progress(work_dir, "running", 5, "正在准备素材...")
        prepared_image = _prepare_image(source_image, work_dir)
        prepared_audio = _prepare_audio(audio_path, work_dir)
        chunks = _slice_audio(prepared_audio, work_dir)
        total_chunks = len(chunks)
        _log(f"audio sliced into {total_chunks} chunk(s)")

        _write_progress(work_dir, "running", 10, "正在上传形象图...")
        policy = _get_upload_policy(api_key)
        image_oss_url = _upload_file_to_oss(policy, prepared_image)

        _write_progress(work_dir, "running", 15, "正在检测图片...")
        _detect_image(api_key, image_oss_url)

        segment_paths: list[Path] = []
        completed_seconds = 0.0
        for idx, (chunk_path, chunk_duration) in enumerate(chunks):
            base_percent = 20 + int((idx / total_chunks) * 70)
            _write_progress(
                work_dir,
                "running",
                base_percent,
                f"正在生成第 {idx + 1}/{total_chunks} 段视频...",
            )

            try:
                policy = _get_upload_policy(api_key)
                audio_oss_url = _upload_file_to_oss(policy, chunk_path)

                task_id = _submit_video(api_key, image_oss_url, audio_oss_url, style, resolution)
                _log(f"segment {idx + 1}/{total_chunks} task_id={task_id}")

                result = _poll_task(api_key, task_id)
                output = result.get("output", {}) if isinstance(result, dict) else {}
                if output.get("task_status") != "SUCCEEDED":
                    raise DashScopeError(output if isinstance(output, dict) else {"message": str(output)})

                video_url = (
                    output.get("video_url")
                    or output.get("results", {}).get("video_url")
                    or output.get("result", {}).get("video_url")
                )
                if not video_url:
                    raise DashScopeError({"message": "任务成功但未返回视频地址"})

                segment_path = work_dir / f"segment_{idx:03d}.mp4"
                _download_video(video_url, segment_path)
                if not segment_path.is_file() or segment_path.stat().st_size == 0:
                    raise RuntimeError(f"第 {idx + 1} 段视频下载失败")
                segment_paths.append(segment_path)
                completed_seconds += chunk_duration
            except DashScopeError as dse:
                code, _ = _classify_error(dse)
                if code == "INSUFFICIENT_BALANCE":
                    raise BalanceExhaustedError(completed_seconds, len(segment_paths)) from dse
                raise

        _write_progress(work_dir, "running", 95, "正在拼接视频片段...")
        _concat_videos(ffmpeg, segment_paths, output_path)
        if not output_path.is_file() or output_path.stat().st_size == 0:
            _write_progress(work_dir, "error", error="视频拼接失败，输出文件为空", error_code="DOWNLOAD_FAILED")
            return 1

        _write_progress(
            work_dir,
            "done",
            100,
            "完成",
            video_path=str(output_path.resolve()),
        )
        return 0

    except BalanceExhaustedError as bee:
        _log(traceback.format_exc())
        if _try_write_partial(work_dir, ffmpeg, segment_paths, completed_seconds, resolution):
            return 0
        code, msg = _classify_error(bee.__cause__)
        _write_progress(work_dir, "error", error=msg, error_code=code)
        return 1

    except Exception as e:
        code, msg = _classify_error(e)
        _log(traceback.format_exc())
        if code == "INSUFFICIENT_BALANCE" and segment_paths:
            if _try_write_partial(work_dir, ffmpeg, segment_paths, completed_seconds, resolution):
                return 0
        _write_progress(work_dir, "error", error=msg, error_code=code)
        return 1


if __name__ == "__main__":
    sys.exit(main())
