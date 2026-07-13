#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Voice generation backend (cloud): text -> audio via Alibaba Cloud DashScope CosyVoice.

Supports:
    - System voices for cosyvoice-v3-plus: longanhuan / longanyang
    - Custom voice cloning: upload a local audio sample, create voice_id, then synthesize.

Fixed model: cosyvoice-v3-plus
"""
import json
import os
import sys
import traceback
from pathlib import Path

import requests
from pydub import AudioSegment

POLICY_MODEL = "qwen-vl-plus"
MODEL = "cosyvoice-v3-plus"


def _reconfigure_stdio():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def _log(msg: str):
    print(f"[voice_cloud] {msg}", flush=True, file=sys.stderr)


def _write_progress(
    work_dir: Path,
    status: str,
    percent: int = 0,
    message: str = "",
    audio_path: str = "",
    error: str = "",
    error_code: str = "",
):
    payload = {
        "status": status,
        "progress": {"percent": percent, "message": message},
    }
    if audio_path:
        payload["audio_path"] = str(audio_path)
    if error:
        payload["error"] = str(error)
    if error_code:
        payload["error_code"] = str(error_code)
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


def _api_call(method: str, url: str, api_key: str, json_body: dict | None = None,
              extra_headers: dict | None = None, timeout: int = 60,
              data=None, files=None) -> dict | requests.Response:
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    method = method.upper()
    _log(f"API {method} {url}")
    if json_body is not None:
        _log(f"API body: {json.dumps(json_body, ensure_ascii=False)}")
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
        raise RuntimeError(err)
    content_type = resp.headers.get("Content-Type", "")
    if "application/json" in content_type:
        return resp.json()
    return resp


def _get_upload_policy(api_key: str, model: str = POLICY_MODEL) -> dict:
    url = f"https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model={model}"
    resp = _api_call("GET", url, api_key, extra_headers={"Content-Type": "application/json"}, timeout=30)
    if isinstance(resp, requests.Response):
        data = resp.json().get("data") if resp.text else {}
    else:
        data = resp.get("data") if isinstance(resp, dict) else {}
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
        _log(f"OSS POST {upload_url}")
        resp = requests.post(upload_url, data=fields, files=files, timeout=180)
        _log(f"OSS response status: {resp.status_code}")
        if not resp.ok:
            text = resp.text[:500]
            _log(f"OSS upload error: {text}")
            raise RuntimeError(f"OSS 上传失败: {text}")
    return f"oss://{key}"


def _create_custom_voice(api_key: str, workspace_id: str, audio_oss_url: str) -> str:
    url = f"https://{workspace_id}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/customization"
    body = {
        "model": "voice-enrollment",
        "input": {
            "action": "create_voice",
            "target_model": MODEL,
            "prefix": "voicevideo",
            "url": audio_oss_url,
        },
    }
    resp = _api_call(
        "POST",
        url,
        api_key,
        json_body=body,
        extra_headers={"X-DashScope-OssResourceResolve": "enable"},
        timeout=120,
    )
    if isinstance(resp, requests.Response):
        result = resp.json()
    else:
        result = resp
    _log(f"create voice response: {json.dumps(result, ensure_ascii=False)}")
    output = result.get("output", {}) if isinstance(result, dict) else {}
    voice_id = output.get("voice") or output.get("voice_id")
    if not voice_id:
        raise RuntimeError(f"创建音色未返回 voice_id: {result}")
    return voice_id


def _synthesize(api_key: str, workspace_id: str, text: str, voice: str, rate: float) -> bytes:
    url = f"https://{workspace_id}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer"
    body = {
        "model": MODEL,
        "input": {
            "text": text,
            "voice": voice,
            "format": "wav",
            "sample_rate": 24000,
            "rate": rate,
        },
    }
    resp = _api_call("POST", url, api_key, json_body=body, timeout=300)
    if isinstance(resp, dict):
        # v3-plus REST 接口返回 JSON，音频在 output.audio.url
        output = resp.get("output", {})
        audio_info = output.get("audio", {}) if isinstance(output, dict) else {}
        audio_url = audio_info.get("url") if isinstance(audio_info, dict) else None
        if not audio_url:
            raise RuntimeError(f"语音合成返回 JSON 但无音频 URL: {resp}")
        _log(f"downloading audio from {audio_url[:120]}...")
        audio_resp = requests.get(audio_url, timeout=120)
        audio_resp.raise_for_status()
        return audio_resp.content
    # 某些接口直接返回二进制音频
    return resp.content


def _classify_error(exc: Exception) -> tuple[str, str]:
    exc_text = str(exc).lower()
    payload = {}
    if isinstance(exc, RuntimeError) and isinstance(exc.args[0], dict):
        payload = exc.args[0]
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
    if isinstance(exc, requests.exceptions.Timeout) or "timeout" in exc_text:
        return "NETWORK_ERROR", "连接阿里云百炼服务器超时，请检查网络后重试"

    if "401" in exc_text or code in ("InvalidApiKey", "invalid_api_key", "AccessDenied"):
        return "AUTH_FAILED", "API Key 无效或已过期，请检查设置"

    if code in ("InsufficientBalance", "QuotaExhausted", "Arrearage") or "余额" in message or "额度" in message or "insufficient" in message or "quota" in message or "arrearage" in message or "good standing" in message:
        return "INSUFFICIENT_BALANCE", "阿里云百炼账户额度不足，请前往控制台充值"

    if code in ("ContentModeration", "ImageContentViolation") or "不合规" in message or "审核" in message:
        return "CONTENT_MODERATION", "内容审核未通过，请更换文案或音色"

    if code in ("InvalidInput", "InvalidParameter", "InvalidURL", "InvalidFile.Resolution") or "url" in message or "参数" in message or "未通过" in message:
        return "INVALID_INPUT", f"输入不符合要求：{payload.get('message') or '请检查文案、音色或音频样本'}"

    if code == "ModelUnavailable":
        return "TASK_FAILED", "阿里云百炼服务暂时不可用，请稍后重试"

    if message:
        return "TASK_FAILED", f"云端返回错误：{payload.get('message') or message}"

    return "UNKNOWN_ERROR", f"未知错误：{exc}"


def main():
    _reconfigure_stdio()
    _log("CosyVoice cloud generator started")

    try:
        args = _load_args()
    except Exception as e:
        _log(f"参数读取失败: {e}")
        return 1

    work_dir = Path(args["work_dir"])
    text = args["text"]
    speaker = args.get("speaker", "longanhuan")
    speed = float(args.get("speed", 1.0))
    workspace_id = args.get("workspace_id", "")
    output_path = Path(args.get("output_path", work_dir / "output.wav"))
    custom_sample = args.get("custom_voice_sample", "")

    if not text:
        _write_progress(work_dir, "error", error="缺少合成文案", error_code="INVALID_INPUT")
        return 1
    if not workspace_id:
        _write_progress(work_dir, "error", error="缺少业务空间 ID", error_code="INVALID_INPUT")
        return 1

    api_key = os.environ.get("DASHSCOPE_API_KEY") or ""
    if not api_key:
        _write_progress(work_dir, "error", error="未设置 DASHSCOPE_API_KEY", error_code="AUTH_FAILED")
        return 1

    try:
        _write_progress(work_dir, "running", 5, "正在准备云端合成...")

        voice = speaker
        if custom_sample:
            sample_path = Path(custom_sample)
            if not sample_path.is_file():
                _write_progress(work_dir, "error", error=f"自定义音色样本不存在: {custom_sample}", error_code="INVALID_INPUT")
                return 1
            _write_progress(work_dir, "running", 15, "正在上传音色样本...")
            policy = _get_upload_policy(api_key)
            audio_oss_url = _upload_file_to_oss(policy, sample_path)
            _write_progress(work_dir, "running", 30, "正在创建自定义音色...")
            voice = _create_custom_voice(api_key, workspace_id, audio_oss_url)
            _log(f"custom voice_id={voice}")

        _write_progress(work_dir, "running", 50, "正在合成语音...")
        audio_bytes = _synthesize(api_key, workspace_id, text, voice, speed)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(audio_bytes)

        duration = 0.0
        try:
            audio = AudioSegment.from_file(str(output_path))
            duration = len(audio) / 1000.0
        except Exception as e:
            _log(f"读取音频时长失败: {e}")

        _write_progress(
            work_dir,
            "done",
            100,
            "完成",
            audio_path=str(output_path.resolve()),
        )
        # 额外把时长写回 output.json，方便 C++ 透传
        try:
            out = work_dir / "output.json"
            with open(out, "r", encoding="utf-8") as f:
                data = json.load(f)
            data["duration"] = duration
            with open(out, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
        except Exception:
            pass
        return 0

    except Exception as e:
        code, msg = _classify_error(e)
        _log(traceback.format_exc())
        _write_progress(work_dir, "error", error=msg, error_code=code)
        return 1


if __name__ == "__main__":
    sys.exit(main())
