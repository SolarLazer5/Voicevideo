import os
from pathlib import Path

try:
    import chardet
except ImportError:
    print("请先安装 chardet: pip install chardet")
    exit(1)

def convert_to_utf8_bom(root_dir="."):
    extensions = {".html", ".css", ".js"}
    for ext in extensions:
        for file_path in Path(root_dir).rglob(f"*{ext}"):
            with open(file_path, "rb") as f:
                raw = f.read()

            # 跳过已有 BOM 的文件
            if raw.startswith(b"\xef\xbb\xbf"):
                print(f"跳过: {file_path}")
                continue

            # 检测编码
            detected = chardet.detect(raw)
            encoding = detected.get("encoding") or "utf-8"

            # 解码
            try:
                text = raw.decode(encoding)
            except Exception as e:
                print(f"解码失败 {file_path}: {e}")
                continue

            # 写入 UTF-8 with BOM
            with open(file_path, "wb") as f:
                f.write(b"\xef\xbb\xbf")
                f.write(text.encode("utf-8"))

            print(f"已转换: {file_path}")

    print("\n全部完成！")

if __name__ == "__main__":
    convert_to_utf8_bom()