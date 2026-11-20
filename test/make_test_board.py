#!/usr/bin/env python3
"""Render a known-FEN test board with Lichess cburnett pieces, plus PWA icons.
Test FEN: r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1
(after 1.e4 e5 2.Bc4 Nc6 3.Qh5 — a real opening position, white to move)
"""
import io, urllib.request
from pathlib import Path
from PIL import Image
import cairosvg

BASE = Path(__file__).resolve().parent.parent
SVG_DIR = BASE / "test" / "svg"
SVG_DIR.mkdir(parents=True, exist_ok=True)

PIECES = ["wP","wN","wB","wR","wQ","wK","bP","bN","bB","bR","bQ","bK"]
URL = "https://raw.githubusercontent.com/lichess-org/lila/master/public/piece/cburnett/{}.svg"

def fetch_pieces():
    for p in PIECES:
        dest = SVG_DIR / f"{p}.svg"
        if not dest.exists() or dest.stat().st_size < 500:
            print(f"downloading {p} ...")
            urllib.request.urlretrieve(URL.format(p), dest)
        print(p, dest.stat().st_size, "bytes")

def raster(piece, size):
    png = cairosvg.svg2png(url=str(SVG_DIR / f"{piece}.svg"),
                           output_width=size, output_height=size)
    return Image.open(io.BytesIO(png)).convert("RGBA")

def render_board(fen_placement, size=800, out=None):
    sq = size // 8
    light = (240, 217, 181)
    dark = (181, 136, 99)
    img = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    cache = {}
    rows = fen_placement.split("/")
    assert len(rows) == 8
    for r, row in enumerate(rows):
        f = 0
        for ch in row:
            if ch.isdigit():
                f += int(ch)
                continue
            piece = ("w" if ch.isupper() else "b") + ch.upper()
            if piece not in cache:
                cache[piece] = raster(piece, sq)
            x0, y0 = f * sq, r * sq
            img.paste(cache[piece], (x0, y0), cache[piece])
            f += 1
    # paint squares UNDER pieces: redo properly — draw board first, then pieces
    board = Image.new("RGBA", (size, size))
    from PIL import ImageDraw
    d = ImageDraw.Draw(board)
    for r in range(8):
        for f in range(8):
            d.rectangle([f*sq, r*sq, (f+1)*sq, (r+1)*sq],
                        fill=light if (r+f) % 2 == 0 else dark)
    board.paste(img, (0, 0), img)
    # NOTE: pieces were pasted on white bg in img; paste with img as mask
    # loses nothing because piece PNGs have transparency and img bg is white
    # opaque — instead rebuild cleanly:
    clean = Image.new("RGBA", (size, size))
    d2 = ImageDraw.Draw(clean)
    for r in range(8):
        for f in range(8):
            d2.rectangle([f*sq, r*sq, (f+1)*sq, (r+1)*sq],
                         fill=light if (r+f) % 2 == 0 else dark)
    for r, row in enumerate(rows):
        f = 0
        for ch in row:
            if ch.isdigit():
                f += int(ch); continue
            piece = ("w" if ch.isupper() else "b") + ch.upper()
            clean.paste(cache[piece], (f*sq, r*sq), cache[piece])
            f += 1
    clean.convert("RGB").save(out)
    print(f"wrote {out} ({size}x{size})")

def make_icon(size, out):
    # 8x8 board filling the canvas, big white knight centred on a dark disc
    sq = size // 8
    light = (240, 217, 181); dark = (181, 136, 99)
    img = Image.new("RGBA", (size, size))
    from PIL import ImageDraw
    d = ImageDraw.Draw(img)
    for r in range(8):
        for f in range(8):
            d.rectangle([f*sq, r*sq, (f+1)*sq, (r+1)*sq],
                        fill=light if (r+f) % 2 == 0 else dark)
    # dark green disc centre
    cx = cy = size // 2
    rad = int(size * 0.34)
    d.ellipse([cx-rad, cy-rad, cx+rad, cy+rad], fill=(38, 90, 60, 255))
    knight = raster("wN", int(size * 0.52))
    img.paste(knight, (cx - knight.width//2, cy - knight.height//2), knight)
    img.convert("RGB").save(out)
    print(f"wrote {out} ({size}x{size})")

if __name__ == "__main__":
    fetch_pieces()
    placement = "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR"
    render_board(placement, 800, BASE / "test" / "test-board.png")
    make_icon(192, BASE / "icons" / "icon-192.png")
    make_icon(512, BASE / "icons" / "icon-512.png")
