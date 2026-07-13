#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LinkVideoExtract 后端脚本：下载视频 / 读取本地视频 → 抽取音频 → FunASR 转写文案。

用法：
    python extract_link.py <args_json_path>

args_json 格式：
    {
        "url": "https://..." 或本地文件绝对路径,
        "work_dir": "..."     // 可选，临时工作目录
    }

标准输出：JSON
    {"text": "转写结果"}
    {"error": "错误描述"}
"""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import re
import time
import traceback
from pathlib import Path

import requests


def _setup_localdep():
    """如果存在 localdep 目录，则优先使用其中的离线模型，禁止运行时下载。"""
    candidates = []
    if os.environ.get("VOICEVIDEO_LOCALDEP"):
        candidates.append(Path(os.environ["VOICEVIDEO_LOCALDEP"]))

    script_dir = Path(__file__).resolve().parent
    for parent in [script_dir, script_dir.parent, script_dir.parent.parent]:
        candidates.append(parent / "localdep")
        candidates.append(parent.parent / "localdep")

    # 也去 exe 所在目录（C++ 当前工作目录）找
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
            # 只要 localdep 存在就强制离线，避免运行时下载
            os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            os.environ.setdefault("MODELSCOPE_HUB_ENABLE_INFERENCE", "0")
            return


_setup_localdep()

# 强制 Windows 重定向输出时使用 UTF-8，避免 C++ 侧 JSON 解析出现乱码/非法字节
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# 保存原始 stdout，后续把库日志重定向到这里避免污染最终 JSON 输出
_ORIGINAL_STDOUT = sys.stdout
_LIB_STDOUT_BUFFER = io.StringIO()


def log(msg: str):
    """打印进度信息到 stderr，C++ 侧可选捕获。"""
    print(msg, file=sys.stderr, flush=True)


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def find_ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    # 常见 Windows 安装位置兜底
    candidates = [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        r"D:\ffmpeg\bin\ffmpeg.exe",
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    raise RuntimeError("未找到 ffmpeg，请确保 ffmpeg 已安装并加入 PATH")


_WORK_DIR: "Path | None" = None


def load_args() -> dict:
    if len(sys.argv) < 2:
        raise RuntimeError("缺少参数文件路径")
    args_path = Path(sys.argv[1])
    if not args_path.is_file():
        raise RuntimeError(f"参数文件不存在: {args_path}")
    with open(args_path, "r", encoding="utf-8") as f:
        return json.load(f)


def is_local_file(url: str) -> bool:
    maybe = url
    if maybe.startswith("file://"):
        maybe = maybe[7:]
    if maybe.startswith("file:///"):
        maybe = maybe[8:]
    if len(maybe) > 2 and maybe[0] == "/" and maybe[2] == ":":
        maybe = maybe[1:]
    return os.path.isfile(maybe)


def normalize_local_path(url: str) -> str:
    maybe = url
    if maybe.startswith("file://"):
        maybe = maybe[7:]
    if maybe.startswith("file:///"):
        maybe = maybe[8:]
    if len(maybe) > 2 and maybe[0] == "/" and maybe[2] == ":":
        maybe = maybe[1:]
    return os.path.abspath(maybe)


def normalize_url(url: str) -> str:
    """把常见分享链接/特殊格式转换成 yt-dlp 更可能支持的 URL。"""
    import re

    # 抖音精选页 modal_id 形式 -> /video/<modal_id>
    m = re.search(r"douyin\.com/[^\s?]*[?&]modal_id=(\d+)", url, re.IGNORECASE)
    if m:
        return f"https://www.douyin.com/video/{m.group(1)}"

    # 抖音短链 v.douyin.com/xxxxx 保持原样，yt-dlp 支持自动跳转
    # 小红书 xhslink.com/xxxxx 保持原样
    # 快手 kuaishou.com/f/xxxxx 或 kuaishou.com/short-video/xxxxx 保持原样

    return url.strip()


def _is_douyin_url(url: str) -> bool:
    lowered = url.lower()
    return "douyin.com" in lowered or "v.douyin.com" in lowered or "iesdouyin.com" in lowered


def run_ffmpeg(input_path: str, output_wav: str) -> None:
    ffmpeg = find_ffmpeg()
    cmd = [
        ffmpeg,
        "-y",
        "-i", input_path,
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        output_wav,
    ]
    log(f"[extract_link] 抽取音频: {' '.join(cmd)}")
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="ignore",
    )
    if proc.returncode != 0:
        err = proc.stderr[-800:] if proc.stderr else "unknown ffmpeg error"
        raise RuntimeError(f"ffmpeg 音频抽取失败 (code={proc.returncode}): {err}")


def _is_cookie_error(err_msg: str) -> bool:
    lowered = err_msg.lower()
    return (
        "cookie" in lowered
        or "login" in lowered
        or "private" in lowered
        or "验证" in err_msg
        or "verify" in lowered
        or "fresh cookies" in lowered
    )


def _find_cookiefile() -> str:
    """查找用户提供的 cookies.txt，优先 localdep，其次 tools 目录。"""
    script_dir = Path(__file__).resolve().parent
    candidates = [
        Path.cwd() / "localdep" / "cookies.txt",
        script_dir.parent / "localdep" / "cookies.txt",
        script_dir / "cookies.txt",
    ]
    localdep_env = os.environ.get("VOICEVIDEO_LOCALDEP")
    if localdep_env:
        candidates.insert(0, Path(localdep_env) / "cookies.txt")
    for cand in candidates:
        if cand.is_file():
            return str(cand)
    return ""


def _try_download(url: str, work_dir: Path, use_cookies: str = None, cookiefile: str = "") -> str:
    from yt_dlp import YoutubeDL

    outtmpl = str(work_dir / "video.%(ext)s")
    ydl_opts = {
        "outtmpl": outtmpl,
        "format": "bestaudio/best",
        "quiet": True,
        "no_warnings": True,
        "retries": 3,
        "fragment_retries": 3,
    }
    if cookiefile:
        ydl_opts["cookiefile"] = cookiefile
    if use_cookies:
        # yt-dlp 需要 tuple/list，字符串会被拆成单个字符导致参数错误
        ydl_opts["cookiesfrombrowser"] = (use_cookies,)

    with YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if not info:
            raise RuntimeError("yt-dlp 未返回视频信息")
        downloaded = ydl.prepare_filename(info)
        if not os.path.isfile(downloaded):
            files = [f for f in os.listdir(work_dir) if f.startswith("video.")]
            if files:
                downloaded = str(work_dir / files[0])
            else:
                raise RuntimeError("yt-dlp 下载后未找到视频文件")
        return downloaded


def download_video_ytdlp(url: str, work_dir: Path) -> str:
    try:
        with contextlib.redirect_stdout(_LIB_STDOUT_BUFFER):
            from yt_dlp import YoutubeDL
    except Exception as e:
        raise RuntimeError(f"yt-dlp 未安装或加载失败: {e}")

    url = normalize_url(url)
    log(f"[extract_link] 开始下载: {url}")

    cookiefile = _find_cookiefile()
    if cookiefile:
        log(f"[extract_link] 使用 cookies.txt: {cookiefile}")
        try:
            return _try_download(url, work_dir, cookiefile=cookiefile)
        except Exception as e:
            err_msg = str(e)
            if not _is_cookie_error(err_msg):
                raise RuntimeError(f"视频下载失败: {err_msg}")

    # 第一次：无 Cookie 尝试
    try:
        return _try_download(url, work_dir)
    except Exception as e:
        err_msg = str(e)
        if not _is_cookie_error(err_msg):
            raise RuntimeError(f"视频下载失败: {err_msg}")

    # 第二次：尝试从浏览器读取 Cookie（Chrome / Edge / Firefox）
    for browser in ("chrome", "edge", "firefox"):
        log(f"[extract_link] 尝试使用 {browser} 浏览器 Cookie 重新下载...")
        try:
            return _try_download(url, work_dir, use_cookies=browser)
        except Exception as e2:
            err_msg2 = str(e2)
            if not _is_cookie_error(err_msg2):
                raise RuntimeError(f"视频下载失败: {err_msg2}")
            log(f"[extract_link] {browser} Cookie 尝试失败: {err_msg2}")

    raise RuntimeError(
        f"下载失败（需要登录/Cookie，或平台暂不支持）: {err_msg}\n"
        f"提示：\n"
        f"1. 先在浏览器中登录该平台，关闭浏览器后重试；\n"
        f"2. 将导出的 cookies.txt 放到 localdep/cookies.txt 或 tools/cookies.txt；\n"
        f"3. 将视频下载到本地后，通过“上传音频/视频”区域选择文件继续提取。"
    )


# 模拟移动端访问抖音分享页，绕过 PC 端风控
_DOUYIN_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) EdgiOS/121.0.2277.107 Version/17.0 Mobile/15E148 Safari/604.1"
    )
}


def _extract_first_url(text: str) -> str:
    """从用户输入（可能混有文案）中提取第一个 http/https 链接。"""
    urls = re.findall(
        r"http[s]?://(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\(\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+",
        text,
    )
    if not urls:
        raise ValueError("未找到有效的分享链接")
    return urls[0]


def download_douyin(url: str, work_dir: Path) -> str:
    """复用 douyin-mcp-server 思路：移动端分享页解析 → 无水印下载 → 本地转写。"""
    try:
        with contextlib.redirect_stdout(_LIB_STDOUT_BUFFER):
            import requests
    except Exception as e:
        raise RuntimeError(f"requests 未安装或加载失败: {e}")

    log(f"[extract_link] 解析抖音分享链接: {url}")
    try:
        share_url = _extract_first_url(url)
    except Exception as e:
        raise RuntimeError(f"从输入中提取抖音链接失败: {e}")

    try:
        share_response = requests.get(share_url, headers=_DOUYIN_HEADERS, timeout=20)
        share_response.raise_for_status()
    except Exception as e:
        raise RuntimeError(f"访问抖音分享链接失败: {e}")

    final_url = share_response.url
    try:
        video_id = final_url.split("?")[0].strip("/").split("/")[-1]
        if not video_id or not video_id.isdigit():
            raise ValueError(f"无法从跳转地址解析视频ID: {final_url}")
    except Exception as e:
        raise RuntimeError(f"解析视频ID失败: {e}")

    ies_url = f"https://www.iesdouyin.com/share/video/{video_id}"
    try:
        response = requests.get(ies_url, headers=_DOUYIN_HEADERS, timeout=20)
        response.raise_for_status()
    except Exception as e:
        raise RuntimeError(f"获取抖音分享页失败: {e}")

    pattern = re.compile(r"window\._ROUTER_DATA\s*=\s*(.*?)</script>", re.DOTALL)
    find_res = pattern.search(response.text)
    if not find_res or not find_res.group(1):
        raise RuntimeError("从抖音HTML中解析视频信息失败")

    try:
        json_data = json.loads(find_res.group(1).strip())
    except Exception as e:
        raise RuntimeError(f"解析抖音页面数据失败: {e}")

    VIDEO_ID_PAGE_KEY = "video_(id)/page"
    NOTE_ID_PAGE_KEY = "note_(id)/page"
    loader_data = json_data.get("loaderData", {})

    if VIDEO_ID_PAGE_KEY in loader_data:
        original_video_info = loader_data[VIDEO_ID_PAGE_KEY]["videoInfoRes"]
    elif NOTE_ID_PAGE_KEY in loader_data:
        original_video_info = loader_data[NOTE_ID_PAGE_KEY]["videoInfoRes"]
    else:
        raise RuntimeError("无法从抖音页面中解析视频或图集信息")

    try:
        data = original_video_info["item_list"][0]
        video_url = data["video"]["play_addr"]["url_list"][0].replace("playwm", "play")
        if not video_url:
            raise ValueError("无可用视频地址")
    except Exception as e:
        raise RuntimeError(f"提取抖音视频地址失败: {e}")

    log(f"[extract_link] 抖音无水印视频地址: {video_url[:120]}...")

    out_path = work_dir / "video.mp4"
    try:
        with requests.get(video_url, headers=_DOUYIN_HEADERS, stream=True, timeout=120) as r:
            r.raise_for_status()
            with open(out_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=256 * 1024):
                    if chunk:
                        f.write(chunk)
        if out_path.stat().st_size <= 1024:
            raise RuntimeError("下载到的视频文件过小")
    except Exception as e:
        raise RuntimeError(f"下载抖音视频失败: {e}")

    return str(out_path)


def download_video(url: str, work_dir: Path) -> str:
    """根据平台选择最佳下载策略。"""
    url = normalize_url(url)

    # 抖音使用移动端分享页解析方案；失败时直接抛出明细错误
    if _is_douyin_url(url):
        return download_douyin(url, work_dir)

    return download_video_ytdlp(url, work_dir)


# ===================== 云端 ASR（FunASR 异步识别）=====================

def _api_call(method: str, url: str, api_key: str, json_body: dict | None = None,
              extra_headers: dict | None = None, timeout: int = 60) -> dict:
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    method = method.upper()
    log(f"[extract_cloud] API {method} {url}")
    if method == "GET":
        resp = requests.get(url, headers=headers, timeout=timeout)
    else:
        resp = requests.post(url, headers=headers, json=json_body, timeout=timeout)
    log(f"[extract_cloud] API status {resp.status_code}")
    if not resp.ok:
        try:
            err = resp.json()
        except Exception:
            err = {"message": resp.text[:500], "code": f"HTTP_{resp.status_code}"}
        raise RuntimeError(err)
    return resp.json()


def _get_upload_policy(api_key: str, model: str = "qwen-vl-plus") -> dict:
    url = f"https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model={model}"
    resp = _api_call(
        "GET", url, api_key, extra_headers={"Content-Type": "application/json"}, timeout=30
    )
    data = resp.get("data") if isinstance(resp, dict) else None
    if not isinstance(data, dict):
        raise RuntimeError(f"getPolicy 返回异常: {resp}")
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
        log(f"[extract_cloud] OSS POST {upload_url}")
        resp = requests.post(upload_url, data=fields, files=files, timeout=180)
        log(f"[extract_cloud] OSS status {resp.status_code}")
        if not resp.ok:
            text = resp.text[:500]
            raise RuntimeError(f"OSS 上传失败: {text}")
    return f"oss://{key}"


def _submit_asr(api_key: str, workspace_id: str, audio_oss_url: str) -> str:
    url = f"https://{workspace_id}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/asr/transcription"
    body = {
        "model": "fun-asr",
        "input": {"file_urls": [audio_oss_url]},
        "parameters": {"channel_id": [0]},
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
        raise RuntimeError(f"提交 ASR 任务未返回 task_id: {resp}")
    return task_id


def _poll_asr(api_key: str, workspace_id: str, task_id: str, timeout: int = 1800) -> dict:
    url = f"https://{workspace_id}.cn-beijing.maas.aliyuncs.com/api/v1/tasks/{task_id}"
    start = time.time()
    while True:
        resp = _api_call("GET", url, api_key, timeout=60)
        output = resp.get("output", {}) if isinstance(resp, dict) else {}
        status = output.get("task_status")
        log(f"[extract_cloud] task {task_id} status={status}")
        if status in ("SUCCEEDED", "FAILED", "UNKNOWN"):
            return resp
        if time.time() - start > timeout:
            raise TimeoutError(f"ASR 任务 {task_id} 轮询超时")
        time.sleep(5)


def _download_json(url: str) -> dict:
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    return resp.json()


def _extract_text_from_transcription(data: dict) -> str:
    transcripts = data.get("transcripts") if isinstance(data, dict) else None
    if not transcripts:
        raise RuntimeError("识别结果中无 transcripts 字段")
    texts = []
    for ch in transcripts:
        text = ch.get("text", "").strip()
        if not text and "sentences" in ch:
            text = "".join(s.get("text", "") for s in ch["sentences"]).strip()
        if text:
            texts.append(text)
    return "\n".join(texts)


def _classify_cloud_error(exc: Exception) -> tuple[str, str]:
    """把云端 ASR/OSS 错误转换为前端可识别的 error_code 和友好文案。"""
    exc_text = str(exc).lower()
    payload = {}
    if isinstance(exc, RuntimeError) and exc.args and isinstance(exc.args[0], dict):
        payload = exc.args[0]
    # 阿里云百炼常见会把错误包在 {"error": {...}} 里
    if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
        payload = payload["error"]

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
    if code in ("InvalidInput", "InvalidParameter", "BadRequest", "invalid_parameter_error") or "输入" in message or "parameter" in message or "endpoint" in message:
        return "INVALID_INPUT", f"输入不符合要求：{payload.get('message') or '请检查业务空间 ID 或音频文件'}"
    if message:
        return "TASK_FAILED", f"云端返回错误：{payload.get('message') or message}"
    return "UNKNOWN_ERROR", f"未知错误：{exc}"


def _transcribe_cloud(wav_path: str, api_key: str, workspace_id: str) -> str:
    log("[extract_cloud] 开始上传音频到临时 OSS...")
    policy = _get_upload_policy(api_key)
    audio_oss_url = _upload_file_to_oss(policy, Path(wav_path))
    log(f"[extract_cloud] 音频 OSS URL: {audio_oss_url}")

    log("[extract_cloud] 提交 FunASR 异步任务...")
    task_id = _submit_asr(api_key, workspace_id, audio_oss_url)
    log(f"[extract_cloud] task_id={task_id}")

    log("[extract_cloud] 轮询识别结果...")
    result = _poll_asr(api_key, workspace_id, task_id)
    output = result.get("output", {}) if isinstance(result, dict) else {}

    if output.get("task_status") != "SUCCEEDED":
        raise RuntimeError(f"ASR 任务失败: {output}")

    results = output.get("results", [])
    if not results:
        raise RuntimeError("ASR 任务成功但无 results")

    sub = results[0]
    if sub.get("subtask_status") != "SUCCEEDED":
        raise RuntimeError(f"ASR 子任务失败: {sub}")

    transcription_url = sub.get("transcription_url")
    if not transcription_url:
        raise RuntimeError("ASR 结果中无 transcription_url")

    log(f"[extract_cloud] 下载识别结果 JSON...")
    transcription = _download_json(transcription_url)
    text = _extract_text_from_transcription(transcription)
    return text


def transcribe(wav_path: str) -> str:
    try:
        with contextlib.redirect_stdout(_LIB_STDOUT_BUFFER):
            from funasr import AutoModel
    except Exception as e:
        raise RuntimeError(f"FunASR 未安装或加载失败: {e}")

    log("[extract_link] 加载 FunASR 模型（首次使用会自动下载，可能需要几分钟）...")
    try:
        with contextlib.redirect_stdout(_LIB_STDOUT_BUFFER):
            model = AutoModel(
                model="paraformer-zh",
                model_revision="v2.0.4",
                vad_model="fsmn-vad",
                vad_model_revision="v2.0.4",
                punc_model="ct-punc",
                punc_model_revision="v2.0.4",
                disable_update=True,
            )
    except Exception as e:
        raise RuntimeError(f"FunASR 模型加载失败: {e}")

    log("[extract_link] 开始语音转写...")
    try:
        with contextlib.redirect_stdout(_LIB_STDOUT_BUFFER):
            res = model.generate(input=wav_path, batch_size_s=300)
    except Exception as e:
        raise RuntimeError(f"语音转写失败: {e}")

    if not res:
        return ""
    # res 常见为 [{'key': ..., 'text': '...'}]
    if isinstance(res, list):
        texts = []
        for item in res:
            if isinstance(item, dict) and "text" in item:
                texts.append(str(item["text"]))
        return "\n".join(texts).strip()
    if isinstance(res, dict):
        return str(res.get("text", "")).strip()
    return str(res).strip()


def main():
    use_cloud = False
    try:
        args = load_args()
        url = normalize_url(args.get("url", "").strip())
        if not url:
            return finish(error="缺少视频链接或文件路径")

        script_dir = Path(__file__).resolve().parent
        base_work = Path(args.get("work_dir") or (script_dir.parent / "temp" / "extract"))
        ts = str(int(time.time() * 1000))
        work_dir = ensure_dir(base_work / f"job_{ts}")

        # output.json 写入 C++ 传入的 work_dir 根目录，便于异步任务读取
        global _WORK_DIR
        _WORK_DIR = base_work

        log(f"[extract_link] work_dir={work_dir}")

        if is_local_file(url):
            video_path = normalize_local_path(url)
            log(f"[extract_link] 使用本地文件: {video_path}")
        else:
            try:
                video_path = download_video(url, work_dir)
            except RuntimeError as e:
                return finish(error=str(e))
            log(f"[extract_link] 下载完成: {video_path}")

        wav_path = str(work_dir / "audio.wav")
        run_ffmpeg(video_path, wav_path)
        log(f"[extract_link] 音频已抽取: {wav_path}")

        use_cloud = bool(args.get("use_cloud"))
        workspace_id = args.get("workspace_id", "")
        api_key = os.environ.get("DASHSCOPE_API_KEY") or ""

        if use_cloud and api_key and workspace_id:
            text = _transcribe_cloud(wav_path, api_key, workspace_id)
        else:
            text = transcribe(wav_path)
        log(f"[extract_link] 转写完成，长度={len(text)}")

        return finish(text=text)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        if use_cloud:
            code, msg = _classify_cloud_error(e)
            return finish(error=msg, error_code=code)
        return finish(error=f"内部错误: {e}")


def finish(text: str = "", error: str = "", error_code: str = ""):
    sys.stdout = _ORIGINAL_STDOUT
    result = {}
    if error:
        result["error"] = error
        if error_code:
            result["error_code"] = error_code
    else:
        result["text"] = text

    # 同时写入 output.json，方便 C++ 异步任务读取
    try:
        if _WORK_DIR is not None:
            out_path = Path(_WORK_DIR) / "output.json"
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False)
    except Exception:
        pass

    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if not error else 1)


if __name__ == "__main__":
    main()
