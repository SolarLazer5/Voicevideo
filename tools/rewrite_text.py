#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地大模型文案改写脚本（默认使用 Qwen2.5-0.5B-Instruct）。"""

import json
import os
import re
import sys
import traceback
from pathlib import Path


def _reconfigure_stdio():
    """强制 stdout/stderr 使用 UTF-8，避免 Windows 默认 GBK 导致 JSON 乱码。"""
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass


def _setup_localdep():
    """把离线依赖缓存目录指向项目 localdep，支持无网络复用。"""
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent
    localdep = project_root / "localdep"
    if localdep.is_dir():
        os.environ.setdefault("MODELSCOPE_CACHE", str(localdep / "modelscope"))
        os.environ.setdefault("HF_HOME", str(localdep / "huggingface"))
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(localdep / "huggingface" / "hub"))
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "0")
        os.environ.setdefault("HF_HUB_OFFLINE", "0")


def _load_config():
    """读取可选的 tools/rewrite_config.json。"""
    script_dir = Path(__file__).resolve().parent
    config_path = script_dir / "rewrite_config.json"
    defaults = {
        "model_id": "qwen/Qwen2.5-0.5B-Instruct",
        "use_modelscope": True,
        "cache_dir": str(script_dir.parent / "localdep" / "modelscope"),
    }
    if config_path.is_file():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                user_cfg = json.load(f)
            defaults.update(user_cfg)
        except Exception:
            pass
    return defaults


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

# 中文字符约 1~1.5 token，留出余量确保能达到目标字数
LENGTH_TOKENS = {
    "100": 250,
    "300": 600,
    "500": 1000,
    "800": 1700,
    "1000": 2100,
}

LEGAL_SYSTEM_PROMPT = (
    "你是一名法务审核助手。请对用户提供的中文文案进行最小化法务修改：\n"
    "1. 只修改可能引发法律风险的字句，常见风险包括：\n"
    "   - 绝对化用语：最、第一、最佳、最好、全网最低等；\n"
    "   - 夸大/虚假承诺：保证、确保、一夜暴富、无副作用、100%有效等；\n"
    "   - 制造焦虑：错过后悔一辈子、再不行动就晚了等。\n"
    "2. 修改时请使用更柔和、客观、合规的表达，例如：\n"
    "   '最' → '非常'/'很'；'保证让你一夜暴富' → '有望帮助你获得回报'；\n"
    "   '没有任何副作用' → '成分温和，适合大多数人'；\n"
    "   '全网最低价' → '价格具有竞争力'；'错过后悔一辈子' → '建议把握机会'。\n"
    "3. 未修改的部分必须原样保留，禁止重写、扩写或省略原文中的任何句子。\n"
    "4. 输出修改后的完整文案，不要解释。本结果仅作辅助参考，不构成正式法律意见。"
)

LEGAL_REPLACEMENTS = [
    # 绝对化用语
    ("全网最低价", "价格很有竞争力"),
    ("全网最低", "价格很有竞争力"),
    ("最低价", "价格很有竞争力"),
    ("最便宜", "价格很有竞争力"),
    ("最优惠", "非常优惠"),
    ("最好的", "很优秀的"),
    ("最好", "很优秀"),
    ("最佳", "很优秀"),
    ("最优", "很优秀"),
    ("第一", "领先"),
    ("顶级", "优秀"),
    ("绝对", ""),
    # 夸大承诺
    ("保证让你一夜暴富", "有望帮助你获得回报"),
    ("保证让你", "有助于你"),
    ("保证", "有助于"),
    ("确保你", "有助于你"),
    ("确保", "有助于"),
    ("一夜暴富", "获得回报"),
    ("一夜暴利", "获得回报"),
    ("100%有效", "效果值得尝试"),
    ("百分之百有效", "效果值得尝试"),
    ("没有任何副作用", "成分温和"),
    ("无副作用", "成分温和"),
    ("完全无副作用", "成分温和"),
    # 焦虑营销
    ("错过今天后悔一辈子", "建议把握机会"),
    ("错过今天后悔一生", "建议把握机会"),
    ("错过现在后悔一辈子", "建议把握机会"),
    ("错过现在后悔一生", "建议把握机会"),
    ("后悔一辈子", "建议把握机会"),
    ("后悔一生", "建议把握机会"),
    ("再不行动就晚了", "建议尽早了解"),
]


def _apply_legal_rules(text: str) -> str:
    """基于规则对常见法务风险用词做最小化替换。"""
    result = text
    for pattern, repl in LEGAL_REPLACEMENTS:
        result = result.replace(pattern, repl)
    # 清理因删除“绝对”等产生的多余空格或顿号
    result = re.sub(r"[，,]\s*[，,]", "，", result)
    result = re.sub(r"\s+", " ", result).strip()
    return result


def _ensure_model(config):
    """确保模型已下载并返回模型目录。首次调用会联网下载。"""
    model_id = config["model_id"]
    cache_dir = Path(config["cache_dir"]).resolve()
    use_modelscope = bool(config.get("use_modelscope", True))

    # 如果缓存里已有 config.json，则尝试完全离线加载，避免断网时请求元数据失败
    expected_local = cache_dir / "models" / model_id.replace("/", "--")
    local_files_only = (expected_local / "config.json").is_file() or \
                       (expected_local / "configuration.json").is_file()

    if use_modelscope:
        try:
            from modelscope import snapshot_download
            model_dir = snapshot_download(
                model_id,
                cache_dir=str(cache_dir),
                local_files_only=local_files_only,
            )
            return model_dir
        except Exception:
            # 如果离线加载失败，尝试允许联网兜底
            if local_files_only:
                from modelscope import snapshot_download
                model_dir = snapshot_download(
                    model_id,
                    cache_dir=str(cache_dir),
                    local_files_only=False,
                )
                return model_dir
            raise
    else:
        from huggingface_hub import snapshot_download
        model_dir = snapshot_download(
            model_id,
            cache_dir=str(cache_dir),
            local_files_only=local_files_only,
        )
        return model_dir


def _load_model_and_tokenizer(config):
    """加载 tokenizer 和模型，只做一次。"""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    model_dir = _ensure_model(config)
    model_dir = Path(model_dir)
    if not (model_dir / "config.json").is_file() and not (model_dir / "configuration.json").is_file():
        raise RuntimeError(f"模型目录不完整: {model_dir}")

    tokenizer = AutoTokenizer.from_pretrained(str(model_dir), trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        str(model_dir),
        trust_remote_code=True,
        dtype=torch.float32,
    )
    model.eval()
    return tokenizer, model


def _build_messages(style: str, text: str, length_label: str) -> list:
    system = STYLE_PROMPTS.get(style, STYLE_PROMPTS["default"])
    try:
        target = int(length_label)
    except Exception:
        target = 300
    lower = max(1, int(round(target * 0.9)))
    upper = int(round(target * 1.1))
    system = (
        system
        + f" 请严格按用户要求的约{length_label}字输出，控制最终字数在{lower}-{upper}字之间，"
        + "不要输出任何 emoji、markdown 标记、话题标签或非中文字符。"
    )
    user = (
        f"请把以下原文案改写成约{length_label}字的文案，允许±10%字数偏差。"
        f"如果原文比较短，请适当展开细节、补充说明和例子，使最终篇幅接近{length_label}字；"
        f"如果原文较长，请精炼到{length_label}字左右。"
        f"只输出改写后的文案，不要解释。\n\n原文案：\n{text}"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


_EMOJI_RE = re.compile(
    "["
    "\U0001F600-\U0001F64F"   # 表情符号
    "\U0001F300-\U0001F5FF"   # 符号与象形
    "\U0001F680-\U0001F6FF"   # 交通与地图
    "\U0001F1E0-\U0001F1FF"   # 国旗
    "\U00002702-\U000027B0"   # 装饰符号
    "\U000024C2-\U000024FF"   # 带圈字母数字
    "\U0001F200-\U0001F251"   # 带圈表意文字补充
    "\U0001F900-\U0001F9FF"   # 补充符号与象形
    "\U0001FA00-\U0001FA6F"   # 棋类/符号
    "\u2600-\u26FF"           # 杂项符号
    "\u2700-\u27BF"           # 装饰符号
    "\u2B50-\u2BFF"           # 杂项符号和箭头
    "]+",
    flags=re.UNICODE,
)

# 仅保留 CJK 汉字、数字、中文标点和常见空白，用于 TTS 纯中文输出
_ALLOWED_CHAR_RE = re.compile(
    r"[^\u4e00-\u9fa50-9\s，。！？、；：""''（）《》【】—…～·]",
    flags=re.UNICODE,
)


def _clean_output(text: str) -> str:
    """去掉模型可能输出的多余前缀、markdown 标记、emoji、话题标签和非中文字符。"""
    # 去掉常见的角色/解释前缀
    text = re.sub(r"^(改写后的文案[：:]?|assistant[：:]?)\s*", "", text, flags=re.I)
    # 去掉 markdown 标题
    text = re.sub(r"#{1,6}\s*", "", text)
    # 去掉 markdown 无序列表、项目符号、引用
    text = re.sub(r"^[ \t]*[-*+•·◦▪▫—]+\s*", "", text, flags=re.M)
    text = re.sub(r">+\s*", "", text)
    # 去掉 markdown 粗体/斜体/删除线/行内代码符号
    text = re.sub(r"\*+|_+|~+|`+", "", text)
    # markdown 链接保留文字
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    # 去掉 HTML 标签
    text = re.sub(r"<[^>]+>", "", text)
    # 去掉 markdown 表格竖线
    text = text.replace("|", " ")
    # 去掉话题标签
    text = re.sub(r"(?:^|\s)#[\w\u4e00-\u9fff]+", "", text)
    # 去掉 emoji 及常见符号
    text = _EMOJI_RE.sub("", text)
    # 过滤非中文、非数字、非中文标点的字符
    text = _ALLOWED_CHAR_RE.sub("", text)
    # 压缩空白但保留段落换行
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = text.strip()
    return text


def rewrite(args: dict, config: dict) -> dict:
    text = args.get("text", "").strip()
    if not text:
        return {"error": "缺少原文案"}

    mode = args.get("mode", "rewrite")

    # AI 法务：本地规则快速处理常见风险用词，避免小模型生成不稳定
    if mode == "legal":
        return {"text": _apply_legal_rules(text)}

    try:
        tokenizer, model = _load_model_and_tokenizer(config)
    except Exception as e:
        return {"error": f"模型加载失败：{e}"}

    try:
        import torch
        style = args.get("style", "default")
        length = args.get("length", "300")
        max_new_tokens = LENGTH_TOKENS.get(str(length), 550)
        messages = _build_messages(style, text, length)

        prompt = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        inputs = tokenizer(prompt, return_tensors="pt")

        with torch.no_grad():
            outputs = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=True,
                temperature=0.7,
                top_p=0.9,
                repetition_penalty=1.05,
                no_repeat_ngram_size=3,
            )

        generated_ids = outputs[:, inputs.input_ids.shape[1]:]
        generated = tokenizer.batch_decode(generated_ids, skip_special_tokens=True)[0]
        generated = _clean_output(generated)
        return {"text": generated}
    except Exception as e:
        return {"error": f"改写生成失败：{e}"}


def main():
    _reconfigure_stdio()
    _setup_localdep()
    config = _load_config()

    args_path = sys.argv[1] if len(sys.argv) > 1 else None
    args = {}
    if args_path and Path(args_path).is_file():
        try:
            with open(args_path, "r", encoding="utf-8") as f:
                args = json.load(f)
        except Exception as e:
            _write_output({"error": f"读取参数失败：{e}"}, args)
            return

    result = rewrite(args, config)
    _write_output(result, args)


def _write_output(result: dict, args: dict):
    """把结果写入 output.json 并打印到 stdout。"""
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


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        traceback.print_exc()
        print(json.dumps({"error": f"脚本异常：{e}"}, ensure_ascii=False), flush=True)
        sys.exit(1)
