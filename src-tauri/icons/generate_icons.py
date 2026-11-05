#!/usr/bin/env python3
"""Decode icon base64 files into PNG/ICO. Run: python3 generate_icons.py"""
import base64
from pathlib import Path
OUT = Path(__file__).parent
FILES = {
    "32x32.png": "32x32.png.b64",
    "128x128.png": "128x128.png.b64",
    "128x128@2x.png": "128x128_at_2x.png.b64",
    "icon.png": "icon.png.b64",
    "icon.ico": "icon.ico.b64",
}
for name, b64name in FILES.items():
    b64_path = OUT / b64name
    if not b64_path.exists():
        print(f"Missing {b64name}, skipping {name}")
        continue
    b64 = b64_path.read_text().strip()
    (OUT / name).write_bytes(base64.b64decode(b64))
    print("wrote", name)
print("Icons ready.")
