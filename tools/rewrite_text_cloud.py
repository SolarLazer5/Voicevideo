#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cloud text rewrite / legal-check backend via Alibaba Cloud DashScope deepseek-v4-flash."""
import json
import os
import re
import sys
import traceback
from pathlib import Path

import requests

MODEL = "deepseek-v4-flash"

STYLE_PROMPTS = {
    "default": (
        "你是一位专业的中文文案编辑。请在不改变原意的前提下，把文案改写得通顺、自然、有吸引力，适合大众阅读。"
        "只输出纯中文文案，不要添加 emoji、表情符号、markdown 标记（如 #、*、-、>、`）、话题标签或任何非文字符号。"
    ),
    "xiaohongshu": (
        "你是一位小红书种草博主。请用亲切、口语化的种草语气改写文案，分段、短句，增强代入感和分享欲。"
        "只输出纯中文文案，不要添加 emoji、表情符号、markdown 标记（如 #、*、-、>、`）、话题标签或任何非文字符号。"
    ),
    "douyin": (
        "你是一位抖音短视频文案写手。请把文案改写成节奏快、有钩子、适合口播的短句风格，开头要抓人。"
        "只输出纯中文文案，不要添加 emoji、表情符号、markdown 标记（如 #、*、-、>、`）、话题标签或任何非文字符号。"
    ),
    "professional": (
        "你是一位专业内容编辑。请用正式、严谨、商务的语气改写文案，措辞准确、逻辑清晰，避免口语化。"
        "只输出纯中文文案，不要添加 emoji、表情符号、markdown 标记（如 #、*、-、>、`）、话题标签或任何非文字符号。"
    ),
    "humorous": (
        "你是一位擅长幽默表达的文案写手。请用轻松、有趣、适度玩梗的风格改写文案，让读者会心一笑。"
        "只输出纯中文文案，不要添加 emoji、表情符号、markdown 标记（如 #、*、-、>、`）、话题标签或任何非文字符号。"
    ),
}

TRANSLATE_PROMPTS = {
    "en": (
        "你是一位专业翻译。请将用户提供的文案翻译成自然、地道的英文，"
        "只输出译文，不要添加解释、前缀、markdown、emoji、话题标签或任何非文字符号。"
    ),
    "zh": (
        "你是一位专业翻译。请将用户提供的文案翻译成自然、流畅的中文，"
        "只输出译文，不要添加解释、前缀、markdown、emoji、话题标签或任何非文字符号。"
    ),
}

LEGAL_SYSTEM_PROMPT = (
    "你是一名法务审核助手。请对用户提供的中文文案进行最小化法务修改：\n"
    "1. 只修改可能引发法律风险的字句，常见风险包括：\n"
    "   - 绝对化用语：最、第一、最佳、最好、全网最低等；\n"
    "   - 夸大/虚假承诺：保证、确保、一夜暴富、无副作用、100%有效等；\n"
    "   - 制造焦虑：错过后悔一辈子、再不行动就晚了等。\n"
    "2. 修改时请使用更柔和、客观、合规的表达。\n"
    "3. 未修改的部分必须原样保留，禁止重写、扩写或省略原文中的任何句子。\n"
    "4. 输出修改后的完整文案，不要解释。本结果仅作辅助参考，不构成正式法律意见。"
)

# 允许中英文字母、数字、常见中英文标点；emoji 不在白名单内，会被直接过滤。
_ALLOWED_CHAR_RE = re.compile(
    r"[^\u4e00-\u9fa5a-zA-Z0-9\s\n"
    r"，。！？、；：\"\"''“”‘’（）【】《》"
    r".,/?!;:@&+\-]",
    re.UNICODE,
)


def _reconfigure_stdio():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def _log(msg: str):
    print(f"[rewrite_cloud] {msg}", flush=True, file=sys.stderr)


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


def _clean_output(text: str) -> str:
    text = re.sub(r"^(改写后的文案[：:]?|assistant[：:]?)\s*", "", text, flags=re.I)
    text = re.sub(r"#{1,6}\s*", "", text)
    text = re.sub(r"^[ \t]*[-*+•·◦▪▫—]+\s*", "", text, flags=re.M)
    text = re.sub(r">+\s*", "", text)
    text = re.sub(r"\*+|_+|~+|\`+", "", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("|", " ")
    text = re.sub(r"(?:^|\s)#[\w\u4e00-\u9fff]+", "", text)
    text = _ALLOWED_CHAR_RE.sub("", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _classify_error(exc: Exception) -> tuple[str, str]:
    exc_text = str(exc).lower()
    payload = {}
    if isinstance(exc, RuntimeError) and exc.args and isinstance(exc.args[0], dict):
        payload = exc.args[0]
    elif isinstance(exc, requests.exceptions.HTTPError):
        try:
            payload = exc.response.json() if exc.response is not None else {}
        except Exception:
            if exc.response is not None:
                payload = {"message": exc.response.text[:500], "code": f"HTTP_{exc.response.status_code}"}

    # 兼容阿里云百炼的错误包裹：{"error": {"code": ..., "message": ...}}
    if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
        payload = payload["error"]

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
    if code in ("InvalidInput", "InvalidParameter", "BadRequest", "ContextLengthExceeded", "invalid_parameter_error") or "输入" in message or "context" in message or "too long" in message or "endpoint" in message:
        return "INVALID_INPUT", f"输入不符合要求：{payload.get('message') or '请检查业务空间 ID、文案长度或内容'}"
    if message:
        return "TASK_FAILED", f"云端返回错误：{payload.get('message') or message}"
    return "UNKNOWN_ERROR", f"未知错误：{exc}"


def _call_chat(api_key: str, workspace_id: str, messages: list[dict]) -> str:
    url = f"https://{workspace_id}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions"
    body = {
        "model": MODEL,
        "messages": messages,
        "stream": False,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    _log(f"POST {url}")
    resp = requests.post(url, headers=headers, json=body, timeout=300)
    _log(f"status {resp.status_code}")
    if not resp.ok:
        try:
            err = resp.json()
        except Exception:
            err = {"message": resp.text[:500], "code": f"HTTP_{resp.status_code}"}
        raise RuntimeError(err)
    data = resp.json()
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError({"message": "云端返回空 choices"})
    content = choices[0].get("message", {}).get("content", "")
    if not isinstance(content, str):
        raise RuntimeError({"message": "云端返回内容格式异常"})
    return content


def _rewrite(api_key: str, workspace_id: str, text: str, style: str, length: str) -> str:
    prompt = STYLE_PROMPTS.get(style, STYLE_PROMPTS["default"])
    target = str(length) if length else "300"
    messages = [
        {
            "role": "user",
            "content": (
                f"{prompt}\n\n"
                f"请把以下文案改写为大约 {target} 字，只输出纯中文文案，不要添加任何前缀、解释、markdown、emoji、话题标签：\n\n"
                f"{text}"
            ),
        }
    ]
    return _clean_output(_call_chat(api_key, workspace_id, messages))


def _legal_check(api_key: str, workspace_id: str, text: str) -> str:
    messages = [
        {
            "role": "user",
            "content": f"{LEGAL_SYSTEM_PROMPT}\n\n请对以下文案进行最小化法务修改，只输出修改后的完整文案：\n\n{text}",
        }
    ]
    return _clean_output(_call_chat(api_key, workspace_id, messages))


def _translate(api_key: str, workspace_id: str, text: str, target_lang: str) -> str:
    prompt = TRANSLATE_PROMPTS.get(target_lang, TRANSLATE_PROMPTS["en"])
    messages = [
        {
            "role": "user",
            "content": f"{prompt}\n\n{text}",
        }
    ]
    return _clean_output(_call_chat(api_key, workspace_id, messages))


def main():
    _reconfigure_stdio()
    args = {}
    if len(sys.argv) > 1:
        try:
            with open(sys.argv[1], "r", encoding="utf-8") as f:
                args = json.load(f)
        except Exception as e:
            _write_output({"error": f"读取参数失败：{e}"}, args)
            return 1

    text = args.get("text", "").strip()
    if not text:
        _write_output({"error": "缺少原文案"}, args)
        return 1

    workspace_id = args.get("workspace_id", "")
    if not workspace_id:
        _write_output({"error": "缺少业务空间 ID", "error_code": "INVALID_INPUT"}, args)
        return 1

    api_key = os.environ.get("DASHSCOPE_API_KEY") or ""
    if not api_key:
        _write_output({"error": "未设置 DASHSCOPE_API_KEY", "error_code": "AUTH_FAILED"}, args)
        return 1

    mode = args.get("mode", "rewrite")
    try:
        if mode == "legal":
            result_text = _legal_check(api_key, workspace_id, text)
        elif mode == "translate":
            result_text = _translate(api_key, workspace_id, text, args.get("target_lang", "en"))
        else:
            result_text = _rewrite(api_key, workspace_id, text, args.get("style", "default"), args.get("length", "300"))
        _write_output({"text": result_text}, args)
        return 0
    except Exception as e:
        code, msg = _classify_error(e)
        _log(traceback.format_exc())
        _write_output({"error": msg, "error_code": code}, args)
        return 1


if __name__ == "__main__":
    sys.exit(main())
