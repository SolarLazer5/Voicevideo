#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
构建本地音效关键词索引。

扫描 localdep/sfx/ 下的音频文件，根据文件名建立关键词→文件路径的映射，
输出到 localdep/sfx/sfx_index.json。VideoCut 剪辑时会读取该索引做 AI 音效匹配。

运行：
    python tools/build_sfx_index.py
"""

import json
import os
import re
from pathlib import Path


# 关键词到文件名的映射规则
CATEGORY_KEYWORDS = {
    "success": [
        "success", "win", "complete", "victory", "achievement", "levelup", "level_up",
        "fanfare", "positive", "yay", "赞", "成功", "完成", "胜利", "通过", "搞定",
    ],
    "coin": [
        "coin", "coins", "gold", "money", "cash", "reward", "bonus", "collect", "pickup",
        "金币", "奖励", "优惠", "折扣", "福利", "免费", "省钱", "立省",
    ],
    "click": [
        "click", "select", "ui", "button", "tap", "switch", "rollover", "mouseclick",
        "mouserelease", "确认", "点击", "选择", "开启", "打开", "按下",
    ],
    "alert": [
        "alert", "warning", "alarm", "danger", "attention", "bell", "notice",
        "注意", "警告", "紧急", "提醒", "重要",
    ],
    "magic": [
        "magic", "spell", "sparkle", "powerup", "power_up", "buff", "energy", "laser",
        "warp", "惊喜", "魔法", "特效", "神奇", "炫酷",
    ],
    "explosion": [
        "explosion", "explode", "boom", "crash", "smash", "hit", "punch", "impact",
        "chop", "knife", "mining",
        "爆炸", "震惊", "火爆", "爆款", "燃", "撞击", "打击",
    ],
    "cheer": [
        "cheer", "applause", "clap", "yay", "欢呼", "掌声", "喝彩",
    ],
    "sad": [
        "sad", "fail", "lose", "defeat", "negative", "no",
        "悲伤", "失败", "失去",
    ],
}


def _tokenize(text: str):
    """把文件名拆成单词 token（去掉下划线、连字符、数字）。"""
    return [t for t in re.split(r"[\W_0-9]+", text.lower()) if t]


def _keyword_matches(keyword: str, stem: str, tokens: list) -> bool:
    """判断一个关键词是否匹配文件名 stem。"""
    # 中文关键词：子串匹配
    if re.search(r"[\u4e00-\u9fff]", keyword):
        return keyword in stem

    kw = keyword.lower()
    # 英文关键词：整词匹配，或某个 token 以该关键词开头（如 coin -> coins）
    if kw in tokens:
        return True
    if any(t.startswith(kw) for t in tokens):
        return True
    # 作为独立英文单词出现（前后不是字母）
    pattern = r"(?<![a-z])" + re.escape(kw) + r"(?![a-z])"
    return bool(re.search(pattern, stem.lower()))


def build_index(sfx_dir: Path) -> dict:
    index = {cat: [] for cat in CATEGORY_KEYWORDS}
    if not sfx_dir.is_dir():
        return index

    for root, _, files in os.walk(sfx_dir):
        for fname in files:
            low = fname.lower()
            if not low.endswith((".wav", ".mp3", ".ogg", ".m4a", ".flac")):
                continue
            fpath = str(Path(root) / fname).replace("\\", "/")
            stem = Path(fname).stem
            tokens = _tokenize(stem)
            for cat, keywords in CATEGORY_KEYWORDS.items():
                if any(_keyword_matches(kw, stem, tokens) for kw in keywords):
                    if fpath not in index[cat]:
                        index[cat].append(fpath)
    return index


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def main():
    script_dir = Path(__file__).resolve().parent
    sfx_dir = script_dir.parent / "localdep" / "sfx"
    ensure_dir(sfx_dir)
    index = build_index(sfx_dir)
    out_file = sfx_dir / "sfx_index.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f"音效索引已保存: {out_file}")
    for cat, files in index.items():
        print(f"  {cat}: {len(files)} 个文件")


if __name__ == "__main__":
    main()
