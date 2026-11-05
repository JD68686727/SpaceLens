#!/usr/bin/env python3
"""Decode icon base64 files into PNG/ICO. Run: python3 generate_icons.py
If a .b64 is missing, a simple placeholder is written so tauri build still works."""
import base64
import struct
from pathlib import Path

OUT = Path(__file__).parent

FILES = {
    "32x32.png": "32x32.png.b64",
    "128x128.png": "128x128.png.b64",
    "128x128@2x.png": "128x128_at_2x.png.b64",
    "icon.png": "icon.png.b64",
    "icon.ico": "icon.ico.b64",
}

def write_placeholder_png(path: Path, size: int):
    """Minimal valid solid-color PNG without external deps."""
    # Very small precomputed solid sky-blue PNG for common sizes
    # Generated offline; falls back to 32px data for other sizes
    placeholders = {
        32: base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAvElEQVR42mPkF9f6zzCAgIlhgMGoA1jI0fS/bz9OOcYiR5LMYiQlEeKzmFyHEOUAUiwm1SFMtLScGP1MtLScGHOYaG05IfNIzgUfo8S2wtj8y15506QcwOVaZMux8ckJBSZyfE6JIwg6gNpxT8j8oVMX4EpwlCZEkkIA3TJq5AKSsyE1LB1tD+B1AKn1OaW14+CMAlqFAjZzB28ipHYo4DKPiRrtOkqaZUyUaKZGm3BotIoHTb9gtG9ICwAA6ZtLBZoJWXgAAAAASUVORK5CYII="),
        128: base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAACqUlEQVR42u3dsXEUURBFUW2XfHmQA1lgkwFhEAhhkAG28sEjAmHhsVViNbPq7neuqdIYv9/93X92ZmsvTx8/vTwgllICAoAAIAAIAAKAACAACAACgAAgAAgAAoAA2MhjykJfvj//9zWXb5/X1+Wy8YWQW8JOlWKFAGcGvl2I0QK8Z/BbRBgnQKfQN8gwRoAJwU8Uob0AE4OfJEIJP3sdLTvAluAndIMSfvb6SnHCb187jICU4DuOhBJ+9vpL+NkSlPCzJSjhZ0tQws+WoISfLYFXwsIpuz+7C5TwsyUo4WdL4AzgDGD3J3eBEn62BEZAOKc8Dn7P3f/764ef//r7049fX1YEdvDj4xVfDbsW+rX/2SJDyxFw793/mvCPuGbrWeBx865/zfXp3aASw9/SDdoJ4NZv3hio5N2vCxwowD12/5lBTZPgqHr7IMhtIAgQOvudBQ4SwOl/7jnACDACQAAQAARofQC8x0ObiQ+G3lp/HUAHAAGGcGaLTn0vYFwHOCOo5JdCjAAjYB5H7tj0V8LGvhP4N7hbH+B4M3jJCLglSOEv6ADXAt3+xRAC2N1GAAiALgIk/LRaZ95afx1ABwABQAAQwEEw7ACoA4AABAABnAMy578OgGMF0AVm7X4dAAQgQOP2hPPrqwPoAP0txXl11QF0gDm22v3D7gJI0L+ORoARMNdeu39IByBB37rVpsUI3xkAnQXQBfrVqTYvTvhNRwAJ+tSlkhYr/GaHQBJ8fx0qefHp4T88nPTbwbeS9MMTXcQvRcleZylO9vpajYDNI6Gr2KVo2eto3QGmd4MJAo8RYJIIkzrXOAG6yjB1XI0WoIMI088pKwS4pxDbblNXCnCUFAkfTMUIgIGfA4AAIAAIAAKAACAACAACgAAgAAgAAoAAeAN/AKYzCThJ4fvDAAAAAElFTkSuQmCC"),
    }
    data = placeholders.get(size, placeholders[32])
    path.write_bytes(data)
    print(f"wrote placeholder {path.name}")

for name, b64name in FILES.items():
    b64_path = OUT / b64name
    target = OUT / name
    if b64_path.exists():
        b64 = b64_path.read_text().strip()
        target.write_bytes(base64.b64decode(b64))
        print("wrote", name)
    else:
        # Fallback sizes
        size = 32
        if "128" in name and "@2x" in name:
            size = 256
        elif "128" in name:
            size = 128
        elif name == "icon.png":
            size = 512
        elif name == "icon.ico":
            # write a minimal ICO that points to the 32px PNG data
            png = (OUT / "32x32.png").read_bytes() if (OUT / "32x32.png").exists() else base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAvElEQVR42mPkF9f6zzCAgIlhgMGoA1jI0fS/bz9OOcYiR5LMYiQlEeKzmFyHEOUAUiwm1SFMtLScGP1MtLScGHOYaG05IfNIzgUfo8S2wtj8y15506QcwOVaZMux8ckJBSZyfE6JIwg6gNpxT8j8oVMX4EpwlCZEkkIA3TJq5AKSsyE1LB1tD+B1AKn1OaW14+CMAlqFAjZzB28ipHYo4DKPiRrtOkqaZUyUaKZGm3BotIoHTb9gtG9ICwAA6ZtLBZoJWXgAAAAASUVORK5CYII=")
            # Minimal single-PNG ICO
            offset = 6 + 16
            entry = struct.pack("<BBBBHHII", 32, 32, 0, 0, 1, 32, len(png), offset)
            ico = struct.pack("<HHH", 0, 1, 1) + entry + png
            target.write_bytes(ico)
            print("wrote placeholder", name)
            continue
        write_placeholder_png(target, size)

print("Icons ready.")
