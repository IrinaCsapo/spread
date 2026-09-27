#!/usr/bin/env python3
"""Spread image converter.

Drop originals (jpg, png, webp, heic if Pillow supports it) into spread/source-images/
and run:

    python3 spread/tools/optimize.py

Each image becomes two light WebP files in spread/images/:
    name.webp        2000px on the long edge  (big screens, full-bleed spreads)
    name-1000.webp   1000px on the long edge  (phones, thumbnails)

Rotation from the camera is applied, metadata (GPS etc.) is stripped, and
images smaller than the target are never upscaled. A manifest.json with each
image's size is written alongside so the book can lay pages out before the
pixels arrive.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source-images"
OUT = ROOT / "images"
SIZES = {"": 2000, "-1000": 1000}
QUALITY = 80
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff"}


def convert(path: Path) -> dict:
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
        entry = {"width": im.width, "height": im.height, "files": {}}
        for suffix, edge in SIZES.items():
            copy = im.copy()
            copy.thumbnail((edge, edge), Image.LANCZOS)
            dest = OUT / f"{path.stem}{suffix}.webp"
            copy.save(dest, "WEBP", quality=QUALITY, method=6)
            entry["files"][edge] = {
                "src": f"images/{dest.name}",
                "width": copy.width,
                "height": copy.height,
                "kb": round(dest.stat().st_size / 1024),
            }
        return entry


def main() -> int:
    OUT.mkdir(exist_ok=True)
    sources = sorted(p for p in SRC.iterdir() if p.suffix.lower() in EXTS)
    if not sources:
        print(f"No images in {SRC}")
        return 1
    manifest = {}
    before = after = 0
    for p in sources:
        entry = convert(p)
        manifest[p.stem] = entry
        big = entry["files"][2000]
        before += p.stat().st_size
        after += big["kb"] * 1024
        print(f"{p.name:28} {p.stat().st_size // 1024:6} KB -> {big['kb']:4} KB  "
              f"({big['width']}x{big['height']})")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"\n{len(sources)} images: {before // 1024} KB -> {after // 1024} KB at full size")
    return 0


if __name__ == "__main__":
    sys.exit(main())
