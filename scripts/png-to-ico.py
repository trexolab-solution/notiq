"""Convert a PNG to a multi-resolution ICO file."""
import struct, io, os, sys
from PIL import Image

if len(sys.argv) < 3:
    print("Usage: python3 png-to-ico.py <source.png> <output.ico>", file=sys.stderr)
    sys.exit(1)

src = sys.argv[1]
dst = sys.argv[2]
SIZES = [16, 24, 32, 48, 64, 128, 256]

if not os.path.isfile(src):
    print(f"Error: source file not found: {src}", file=sys.stderr)
    sys.exit(1)

try:
    img = Image.open(src).convert("RGBA")
except Exception as e:
    print(f"Error: failed to open image: {e}", file=sys.stderr)
    sys.exit(1)

entries = []
for s in SIZES:
    buf = io.BytesIO()
    img.resize((s, s), Image.LANCZOS).save(buf, format="PNG")
    entries.append((s, buf.getvalue()))

num = len(entries)
header = struct.pack("<HHH", 0, 1, num)
data_offset = 6 + 16 * num
dir_bytes = b""
img_bytes = b""

for s, png_data in entries:
    w = 0 if s >= 256 else s
    dir_bytes += struct.pack(
        "<BBBBHHII", w, w, 0, 0, 1, 32, len(png_data), data_offset + len(img_bytes)
    )
    img_bytes += png_data

with open(dst, "wb") as f:
    f.write(header + dir_bytes + img_bytes)

print(f"ICO: {os.path.getsize(dst):,} bytes, {num} sizes ({SIZES})")
