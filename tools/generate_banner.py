#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BannerGenerate 后端：视频抽帧 + 封面合成

用法：
    python generate_banner.py <args_json_path>

args 示例：
{
    "mode": "extract_frame",
    "video_path": "C:/.../output.mp4",
    "output_path": "C:/.../frame.jpg",
    "max_seconds": 3
}

或：
{
    "mode": "generate",
    "title": "这里是标题",
    "template_index": 0,
    "cover_path": "C:/.../frame.jpg",
    "text_rect": {"x": 0.5, "y": 0.75, "scale": 1.0},
    "output_path": "C:/.../banner.jpg",
    "width": 1080,
    "height": 1920
}
"""

import io
import json
import os
import random
import subprocess
import sys
import traceback
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception:
    Image = ImageDraw = ImageFont = None


def _reconfigure_stdio():
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
    except Exception:
        pass


_reconfigure_stdio()


# ===================== 配置 =====================

BASE_DIR = Path(__file__).resolve().parent.parent
FFMPEG = BASE_DIR / "localdep" / "tools" / "ffmpeg.exe"
FFPROBE = BASE_DIR / "localdep" / "tools" / "ffprobe.exe"

DEFAULT_SIZE = (1080, 1920)


def log(msg: str):
    print(f"[generate_banner] {msg}", flush=True)


def write_output(path: Path, data: dict):
    out = path.with_suffix(path.suffix + ".tmp") if path.suffix else path.parent / (path.name + ".tmp")
    try:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        out.replace(path)
    except Exception:
        pass


def find_ffmpeg() -> str:
    if FFMPEG.exists():
        return str(FFMPEG)
    for name in ("ffmpeg", "ffmpeg.exe"):
        p = subprocess.run(["where", name], capture_output=True, text=True)
        if p.returncode == 0 and p.stdout.strip():
            return p.stdout.strip().splitlines()[0]
    raise RuntimeError("未找到 ffmpeg")


def find_font() -> str:
    """优先返回系统中文字体文件路径，用于 Pillow 绘制。"""
    candidates = [
        BASE_DIR / "localdep" / "fonts" / "NotoSansCJKsc-Bold.otf",
        Path(r"C:\Windows\Fonts\msyhbd.ttc"),
        Path(r"C:\Windows\Fonts\msyh.ttc"),
        Path(r"C:\Windows\Fonts\simhei.ttf"),
        Path(r"C:\Windows\Fonts\simsun.ttc"),
        Path(r"C:\Windows\Fonts\SourceHanSansSC-Bold.otf"),
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return ""


# ===================== 模板定义 =====================

TEMPLATES = [
    # V0: 经典居中白字黑边
    {
        "name": "V0",
        "align": "center",
        "valign": "middle",
        "color": (255, 255, 255),
        "stroke": (0, 0, 0),
        "stroke_width": 4,
        "shadow": (4, 4, (0, 0, 0, 160)),
        "font_size": 160,
        "line_spacing": 1.2,
    },
    # V1: 上方居中大标题
    {
        "name": "V1",
        "align": "center",
        "valign": "top",
        "color": (255, 255, 255),
        "stroke": (219, 112, 255),
        "stroke_width": 3,
        "shadow": (0, 6, (0, 0, 0, 180)),
        "font_size": 180,
        "line_spacing": 1.1,
        "margin_top": 220,
    },
    # V2: 底部居中描边黄字
    {
        "name": "V2",
        "align": "center",
        "valign": "bottom",
        "color": (255, 228, 0),
        "stroke": (0, 0, 0),
        "stroke_width": 5,
        "shadow": (0, 8, (0, 0, 0, 200)),
        "font_size": 170,
        "line_spacing": 1.15,
        "margin_bottom": 220,
    },
    # V3: 左侧竖排感左对齐
    {
        "name": "V3",
        "align": "left",
        "valign": "middle",
        "color": (255, 255, 255),
        "stroke": (0, 0, 0),
        "stroke_width": 4,
        "shadow": (6, 0, (0, 0, 0, 160)),
        "font_size": 150,
        "line_spacing": 1.25,
        "margin_left": 80,
    },
    # V4: 右侧右对齐
    {
        "name": "V4",
        "align": "right",
        "valign": "middle",
        "color": (255, 255, 255),
        "stroke": (0, 0, 0),
        "stroke_width": 4,
        "shadow": (-6, 0, (0, 0, 0, 160)),
        "font_size": 150,
        "line_spacing": 1.25,
        "margin_right": 80,
    },
    # V5: 居中红底白字条
    {
        "name": "V5",
        "align": "center",
        "valign": "middle",
        "color": (255, 255, 255),
        "stroke": None,
        "stroke_width": 0,
        "shadow": None,
        "font_size": 150,
        "line_spacing": 1.2,
        "bar": (255, 60, 80, 220),
        "bar_padding": 40,
    },
    # V6: 底部渐变条白字
    {
        "name": "V6",
        "align": "center",
        "valign": "bottom",
        "color": (255, 255, 255),
        "stroke": None,
        "stroke_width": 0,
        "shadow": None,
        "font_size": 160,
        "line_spacing": 1.2,
        "gradient_bar": True,
        "margin_bottom": 0,
    },
    # V7: 顶部居中紫字
    {
        "name": "V7",
        "align": "center",
        "valign": "top",
        "color": (219, 112, 255),
        "stroke": (255, 255, 255),
        "stroke_width": 3,
        "shadow": (0, 6, (0, 0, 0, 180)),
        "font_size": 170,
        "line_spacing": 1.1,
        "margin_top": 240,
    },
    # V8: 底部左对齐白字
    {
        "name": "V8",
        "align": "left",
        "valign": "bottom",
        "color": (255, 255, 255),
        "stroke": (0, 0, 0),
        "stroke_width": 4,
        "shadow": (4, 4, (0, 0, 0, 160)),
        "font_size": 150,
        "line_spacing": 1.2,
        "margin_left": 70,
        "margin_bottom": 200,
    },
    # V9: 底部右对齐黄字
    {
        "name": "V9",
        "align": "right",
        "valign": "bottom",
        "color": (255, 228, 0),
        "stroke": (0, 0, 0),
        "stroke_width": 4,
        "shadow": (-4, 4, (0, 0, 0, 160)),
        "font_size": 150,
        "line_spacing": 1.2,
        "margin_right": 70,
        "margin_bottom": 200,
    },
    # V10: 居中蓝字白边 + 装饰角标
    {
        "name": "V10",
        "align": "center",
        "valign": "middle",
        "color": (55, 87, 254),
        "stroke": (255, 255, 255),
        "stroke_width": 5,
        "shadow": (0, 8, (0, 0, 0, 200)),
        "font_size": 170,
        "line_spacing": 1.15,
        "badge": (255, 255, 255, 230),
    },
    # V11: 居中细黑字白底
    {
        "name": "V11",
        "align": "center",
        "valign": "middle",
        "color": (0, 0, 0),
        "stroke": (255, 255, 255),
        "stroke_width": 3,
        "shadow": None,
        "font_size": 150,
        "line_spacing": 1.2,
        "bg_box": (255, 255, 255, 200),
        "bg_padding": 50,
    },
]


def hex_to_rgb(value: str) -> tuple:
    value = value.lstrip("#")
    if len(value) == 3:
        value = "".join([c * 2 for c in value])
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def parse_color(value, alpha: float = 1.0) -> tuple:
    """支持 #RRGGBB 或 (R,G,B) 输入，返回带透明度的 RGBA 元组。"""
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        r, g, b = value[:3]
    else:
        r, g, b = hex_to_rgb(str(value or "#FFFFFF"))
    return (int(r), int(g), int(b), int(255 * max(0.0, min(1.0, alpha or 1.0))))


def load_font(size: int, bold: bool = True):
    path = find_font()
    if not path:
        return None
    try:
        return ImageFont.truetype(path, size)
    except Exception as e:
        log(f"load_font failed: {e}")
        return None


def wrap_text(text: str, font, max_width: int, draw) -> list:
    """按最大宽度自动换行。"""
    if not text:
        return []
    lines = []
    for paragraph in text.split("\n"):
        current = ""
        for ch in paragraph:
            test = current + ch
            bbox = draw.textbbox((0, 0), test, font=font)
            if bbox[2] - bbox[0] > max_width and current:
                lines.append(current)
                current = ch
            else:
                current = test
        if current:
            lines.append(current)
    return lines or [text]


# ===================== 抽帧 =====================

def extract_frame(video_path: str, output_path: str, max_seconds: float = 3.0):
    ffmpeg = find_ffmpeg()
    if not os.path.isfile(video_path):
        raise RuntimeError(f"视频文件不存在: {video_path}")
    t = random.uniform(0.0, max(0.1, float(max_seconds) - 0.05))
    cmd = [
        ffmpeg, "-y", "-ss", str(t),
        "-i", video_path,
        "-vframes", "1",
        "-q:v", "2",
        output_path,
    ]
    log(f"extract frame at {t:.2f}s -> {output_path}")
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        err = result.stderr.decode("utf-8", errors="ignore")[:400]
        raise RuntimeError(f"ffmpeg 抽帧失败 (exit={result.returncode}): {err}")


# ===================== 合成 =====================

def load_cover(cover_path: str, size: tuple):
    from PIL import Image
    if not cover_path or not os.path.isfile(cover_path):
        return Image.new("RGB", size, (0, 0, 0))
    img = Image.open(cover_path).convert("RGB")
    w, h = img.size
    tw, th = size
    target_ratio = tw / th
    current_ratio = w / h
    if current_ratio > target_ratio:
        new_h = th
        new_w = int(new_h * current_ratio)
        img = img.resize((new_w, new_h), Image.LANCZOS)
        left = (new_w - tw) // 2
        img = img.crop((left, 0, left + tw, th))
    else:
        new_w = tw
        new_h = int(new_w / current_ratio)
        img = img.resize((new_w, new_h), Image.LANCZOS)
        top = (new_h - th) // 2
        img = img.crop((0, top, tw, top + th))
    return img


def draw_text_unit(base_img: Image.Image, unit: dict, canvas_size: tuple, measure_draw: ImageDraw.ImageDraw):
    """根据前端 text_units 中的单个单元在 base_img 上绘制文本。"""
    text = unit.get("text", "")
    if not text or not text.strip():
        return

    w, h = canvas_size
    font_size = int(unit.get("fontSize", 140))
    bold = unit.get("bold", True)
    font = load_font(font_size, bold) or ImageFont.load_default()

    max_width = int(w * 0.9)
    lines = wrap_text(text, font, max_width, measure_draw)
    if not lines:
        return

    line_spacing = float(unit.get("lineHeight", 1.2))
    align = unit.get("align", "center")

    line_h = 0
    line_widths = []
    for line in lines:
        bbox = measure_draw.textbbox((0, 0), line, font=font)
        lw, lh = bbox[2] - bbox[0], bbox[3] - bbox[1]
        line_widths.append(lw)
        line_h = max(line_h, lh)

    text_block_w = max(line_widths)
    text_block_h = int(len(lines) * line_h * line_spacing)

    bg = unit.get("background", {}) or {}
    padding = int(bg.get("padding", 12))
    layer_w = text_block_w + padding * 2
    layer_h = text_block_h + padding * 2

    layer = Image.new("RGBA", (layer_w, layer_h), (0, 0, 0, 0))
    layer_draw = ImageDraw.Draw(layer)

    # 背景框
    if bg.get("enabled"):
        bg_color = parse_color(bg.get("color", "#000000"), bg.get("opacity", 0.5))
        radius = int(bg.get("radius", 8))
        try:
            layer_draw.rounded_rectangle([0, 0, layer_w - 1, layer_h - 1], radius=radius, fill=bg_color)
        except Exception:
            layer_draw.rectangle([0, 0, layer_w - 1, layer_h - 1], fill=bg_color)

    # 阴影 / 描边
    shadow = unit.get("shadow", {}) or {}
    text_color = parse_color(unit.get("color", "#FFFFFF"), unit.get("opacity", 1.0))
    if shadow.get("enabled"):
        shadow_color = parse_color(shadow.get("color", "#000000"), shadow.get("opacity", 0.5))
        dist = int(shadow.get("distance", 0))
        size = int(shadow.get("size", 0))
        if dist > 0:
            for i, line in enumerate(lines):
                lx = padding
                if align == "center":
                    lx += (text_block_w - line_widths[i]) // 2
                elif align == "right":
                    lx += text_block_w - line_widths[i]
                ly = padding + int(i * line_h * line_spacing)
                layer_draw.text((lx + dist, ly + dist), line, font=font, fill=shadow_color)
        if size > 0:
            # 用描边模拟阴影 size
            for i, line in enumerate(lines):
                lx = padding
                if align == "center":
                    lx += (text_block_w - line_widths[i]) // 2
                elif align == "right":
                    lx += text_block_w - line_widths[i]
                ly = padding + int(i * line_h * line_spacing)
                layer_draw.text((lx, ly), line, font=font, fill=text_color,
                                stroke_width=size, stroke_fill=shadow_color)
            return  # 已绘制文字，避免下方重复绘制

    # 普通文字
    for i, line in enumerate(lines):
        lx = padding
        if align == "center":
            lx += (text_block_w - line_widths[i]) // 2
        elif align == "right":
            lx += text_block_w - line_widths[i]
        ly = padding + int(i * line_h * line_spacing)
        layer_draw.text((lx, ly), line, font=font, fill=text_color)

    # 旋转
    rotation = int(unit.get("rotation", 0))
    if rotation:
        layer = layer.rotate(rotation, expand=True, resample=Image.BICUBIC)

    base_x = int(unit.get("x", 0.5) * w)
    base_y = int(unit.get("y", 0.75) * h)
    paste_x = base_x - layer.width // 2
    paste_y = base_y - layer.height // 2
    base_img.paste(layer, (paste_x, paste_y), layer)


def generate_banner(title: str, template_index: int, cover_path: str,
                    text_rect: dict, output_path: str, size: tuple = DEFAULT_SIZE,
                    text_units: list = None):
    img = load_cover(cover_path, size)
    draw = ImageDraw.Draw(img)

    # 优先使用前端传入的多标题单元
    if text_units:
        tmp = Image.new("RGB", size)
        measure_draw = ImageDraw.Draw(tmp)
        for unit in text_units:
            try:
                draw_text_unit(img, unit, size, measure_draw)
            except Exception as e:
                log(f"draw_text_unit failed: {e}")
        os.makedirs(Path(output_path).parent, exist_ok=True)
        img.save(output_path, "JPEG", quality=95)
        log(f"saved banner: {output_path}")
        return

    tpl = TEMPLATES[template_index % len(TEMPLATES)]

    w, h = size
    base_font_size = int(tpl["font_size"] * text_rect.get("scale", 1.0))
    font = load_font(base_font_size)
    if font is None:
        font = ImageFont.load_default()

    max_text_w = w - 120
    lines = wrap_text(title or " ", font, max_text_w, draw)

    # 计算整段文字尺寸
    line_h = 0
    line_widths = []
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        lw, lh = bbox[2] - bbox[0], bbox[3] - bbox[1]
        line_widths.append(lw)
        line_h = max(line_h, lh)
    text_block_w = max(line_widths) if line_widths else 0
    text_block_h = int(len(lines) * line_h * tpl.get("line_spacing", 1.2))

    # 基础位置：优先使用 text_rect，再用模板默认对齐
    rel_x = text_rect.get("x", 0.5)
    rel_y = text_rect.get("y", 0.5)
    base_x = int(rel_x * w)
    base_y = int(rel_y * h)

    align = tpl.get("align", "center")
    valign = tpl.get("valign", "middle")

    if align == "left":
        x = tpl.get("margin_left", 60)
    elif align == "right":
        x = w - text_block_w - tpl.get("margin_right", 60)
    else:
        x = base_x - text_block_w // 2

    if valign == "top":
        y = tpl.get("margin_top", 120)
    elif valign == "bottom":
        y = h - text_block_h - tpl.get("margin_bottom", 120)
    else:
        y = base_y - text_block_h // 2

    # 限制在画布内
    x = max(20, min(x, w - text_block_w - 20))
    y = max(20, min(y, h - text_block_h - 20))

    # 装饰条 / 背景框
    if "bar" in tpl:
        bar = tpl["bar"]
        bar_x = x - tpl.get("bar_padding", 30)
        bar_y = y - tpl.get("bar_padding", 20)
        bar_w = text_block_w + tpl.get("bar_padding", 30) * 2
        bar_h = text_block_h + tpl.get("bar_padding", 20) * 2
        draw.rectangle([bar_x, bar_y, bar_x + bar_w, bar_y + bar_h], fill=bar)
    elif tpl.get("bg_box"):
        pad = tpl.get("bg_padding", 40)
        box_x = x - pad
        box_y = y - pad
        box_w = text_block_w + pad * 2
        box_h = text_block_h + pad * 2
        draw.rectangle([box_x, box_y, box_x + box_w, box_y + box_h], fill=tpl["bg_box"])
    elif tpl.get("gradient_bar"):
        # 底部渐变条
        bar_h = text_block_h + 120
        for i in range(bar_h):
            alpha = int(200 * (i / bar_h))
            color = (0, 0, 0, alpha)
            draw.line([(0, h - bar_h + i), (w, h - bar_h + i)], fill=color)

    # 绘制阴影
    shadow = tpl.get("shadow")
    if shadow:
        sx, sy, sc = shadow
        for i, line in enumerate(lines):
            lx = x
            ly = y + int(i * line_h * tpl.get("line_spacing", 1.2))
            if align == "center":
                lw = line_widths[i]
                lx = x + (text_block_w - lw) // 2
            elif align == "right":
                lw = line_widths[i]
                lx = x + text_block_w - lw
            draw.text((lx + sx, ly + sy), line, font=font, fill=sc)

    # 绘制文字
    stroke = tpl.get("stroke")
    stroke_width = tpl.get("stroke_width", 0)
    fill = tpl.get("color", (255, 255, 255))
    for i, line in enumerate(lines):
        lx = x
        ly = y + int(i * line_h * tpl.get("line_spacing", 1.2))
        if align == "center":
            lw = line_widths[i]
            lx = x + (text_block_w - lw) // 2
        elif align == "right":
            lw = line_widths[i]
            lx = x + text_block_w - lw
        draw.text((lx, ly), line, font=font, fill=fill,
                  stroke_width=stroke_width, stroke_fill=stroke)

    os.makedirs(Path(output_path).parent, exist_ok=True)
    img.save(output_path, "JPEG", quality=95)
    log(f"saved banner: {output_path}")


# ===================== 主流程 =====================

def main():
    args_path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if not args_path or not args_path.is_file():
        raise RuntimeError(f"参数文件不存在: {args_path}")

    with open(args_path, "r", encoding="utf-8") as f:
        args = json.load(f)

    output_json = Path(args.get("output_json", args_path.parent / "output.json"))
    try:
        mode = args.get("mode")
        if mode == "extract_frame":
            extract_frame(
                args["video_path"],
                args["output_path"],
                float(args.get("max_seconds", 3.0)),
            )
            write_output(output_json, {
                "status": "done",
                "path": args["output_path"].replace("\\", "/"),
            })
        elif mode == "generate":
            text_rect = args.get("text_rect", {"x": 0.5, "y": 0.75, "scale": 1.0})
            generate_banner(
                title=args.get("title", ""),
                template_index=int(args.get("template_index", 0)),
                cover_path=args.get("cover_path", ""),
                text_rect=text_rect,
                output_path=args["output_path"],
                size=(int(args.get("width", DEFAULT_SIZE[0])), int(args.get("height", DEFAULT_SIZE[1]))),
                text_units=args.get("text_units") or None,
            )
            write_output(output_json, {
                "status": "done",
                "path": args["output_path"].replace("\\", "/"),
            })
        else:
            raise RuntimeError(f"未知 mode: {mode}")
    except Exception as e:
        err = traceback.format_exc()
        log(err)
        write_output(output_json, {"status": "error", "error": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
