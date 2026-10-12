"""Builds the Encop brand assets from brand/encop-logo-source.png (the supplied artwork: red mark and
white wordmark on black). Needs Pillow and numpy; run from the repo root:

    python scripts/make_brand_assets.py

Writes the transparent masters to brand/ and the copies the SPA imports to frontend/src/assets/brand/, the
favicon / touch icon to frontend/public/, and frontend/src/components/brand/markShape.ts (the outline of the
red panel and its stripe, used to extrude the mark in 3D).
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "brand" / "encop-logo-source.png"
MASTERS = ROOT / "brand"
ASSETS = ROOT / "frontend" / "src" / "assets" / "brand"
PUBLIC = ROOT / "frontend" / "public"
SHAPE_TS = ROOT / "frontend" / "src" / "components" / "brand" / "markShape.ts"

MARK_BOX = (236, 42, 914, 550)  # the mark; excludes the wordmark and the corner watermark
WORD_BOX = (296, 585, 880, 735)
PANEL_RED = np.array([224, 15, 20], dtype=float)
BG_MAX = 34  # a pixel this dark (max channel) that touches the outside is background


def flood(binary: np.ndarray, seed: tuple[int, int]) -> np.ndarray:
    """Pixels of `binary` connected to `seed` (x, y) through True pixels (4-connected)."""
    h, w = binary.shape
    seen = np.zeros((h, w), dtype=bool)
    sx, sy = seed
    if not binary[sy, sx]:
        return seen
    seen[sy, sx] = True
    stack = [(sy, sx)]
    while stack:
        y, x = stack.pop()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and binary[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                stack.append((ny, nx))
    return seen


def grow(mask: np.ndarray, px: int) -> np.ndarray:
    img = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(px * 2 + 1))
    return np.asarray(img) > 127


def shrink(mask: np.ndarray, px: int) -> np.ndarray:
    return ~grow(~mask, px)


def tight(rgba: np.ndarray, pad: int = 3) -> tuple[Image.Image, tuple[int, int]]:
    ys, xs = np.where(rgba[..., 3] > 0)
    x0, x1, y0, y1 = max(xs.min() - pad, 0), xs.max() + pad + 1, max(ys.min() - pad, 0), ys.max() + pad + 1
    return Image.fromarray(rgba[y0:y1, x0:x1]), (x0, y0)


def rdp(pts: np.ndarray, eps: float) -> np.ndarray:
    """Ramer-Douglas-Peucker on an open polyline."""
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    ab = b - a
    n = np.hypot(*ab) or 1.0
    d = np.abs(ab[0] * (pts[:, 1] - a[1]) - ab[1] * (pts[:, 0] - a[0])) / n
    i = int(d.argmax())
    if d[i] <= eps:
        return np.array([a, b])
    return np.vstack([rdp(pts[: i + 1], eps)[:-1], rdp(pts[i:], eps)])


def hull(points: np.ndarray) -> np.ndarray:
    """Convex hull (Andrew's monotone chain), counter-clockwise in y-up terms."""
    pts = sorted(map(tuple, points.tolist()))

    def half(seq):
        out: list[tuple[float, float]] = []
        for p in seq:
            while len(out) >= 2 and (out[-1][0] - out[-2][0]) * (p[1] - out[-2][1]) - (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0]) <= 0:
                out.pop()
            out.append(p)
        return out

    lower, upper = half(pts), half(reversed(pts))
    return np.array(lower[:-1] + upper[:-1])


def outline(mask: np.ndarray, eps: float = 0.9) -> list[list[float]]:
    """Clean polygon for a convex mask: hull of its edge pixels, then simplified."""
    edge = mask & ~shrink(mask, 1)
    ys, xs = np.where(edge)
    h = hull(np.stack([xs + 0.5, ys + 0.5], axis=1))
    n = len(h)
    # RDP needs two stable halves: split the closed hull at two far-apart vertices
    j = int(np.linalg.norm(h - h[0], axis=1).argmax())
    a = rdp(np.vstack([h[: j + 1]]), eps)
    b = rdp(np.vstack([h[j:], h[:1]]), eps)
    simp = np.vstack([a[:-1], b[:-1]])
    return [[round(float(x), 1), round(float(y), 1)] for x, y in simp]


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    full = np.asarray(Image.open(SRC).convert("RGB")).astype(float)

    # ---------- the mark: remove the black background, un-mix the anti-aliased edge ----------
    rgb = full[MARK_BOX[1] : MARK_BOX[3], MARK_BOX[0] : MARK_BOX[2]]
    mx = rgb.max(axis=2)
    outside = flood(mx <= BG_MAX, (2, 2))
    inside = ~outside
    band = inside & grow(outside, 2)
    solid = inside & ~band
    ref = np.asarray(Image.fromarray((mx * solid).astype(np.uint8)).filter(ImageFilter.MaxFilter(9))).astype(float)
    cov = np.where(band, np.clip(mx / np.maximum(ref, 1), 0, 1), 1.0)
    cov = np.where(outside, 0.0, cov)
    cov[cov < 0.06] = 0.0
    color = np.where(band[..., None], np.clip(rgb / np.maximum(cov[..., None], 0.2), 0, 255), rgb)
    rgba = np.dstack([color, cov * 255]).round().astype(np.uint8)
    mark, (ox, oy) = tight(rgba)
    mark.save(MASTERS / "encop-mark.png")
    mark.save(ASSETS / "encop-mark.png")
    mw, mh = mark.size
    print("mark", mark.size)

    # ---------- shapes: the red panel, its dark stripe, and the hand sitting on the panel ----------
    A = np.asarray(mark).astype(float)
    solid_mask = A[..., 3] >= 128
    panel_seed = np.argwhere(solid_mask & (np.abs(A[..., 0] - PANEL_RED[0]) < 8) & (np.abs(A[..., 1] - PANEL_RED[1]) < 8))
    sy, sx = panel_seed[len(panel_seed) // 2]  # any pixel of flat panel red
    panel = flood(solid_mask, (int(sx), int(sy)))
    stripe = solid_mask & ~panel
    d = np.linalg.norm(A[..., :3] - PANEL_RED, axis=2)
    not_red = panel & shrink(panel, 3) & (d > 28)
    red_bg = flood(~not_red & panel, (int(sx), int(sy)))  # red reachable from the panel without crossing the hand
    hand = panel & shrink(panel, 3) & ~red_bg
    alpha = np.clip(d / 70.0, 0, 1) * hand
    hand_rgb = np.clip(PANEL_RED + (A[..., :3] - PANEL_RED) / np.maximum(alpha[..., None], 0.2), 0, 255)
    hand_rgba = np.dstack([hand_rgb, alpha * 255]).round().astype(np.uint8)
    hand_img, (hx, hy) = tight(hand_rgba, pad=2)
    hand_img.save(ASSETS / "encop-hand.png")
    print("hand", hand_img.size, "at", (hx, hy))

    def fmt(name: str, pts: list[list[float]]) -> str:
        body = ", ".join(f"[{x}, {y}]" for x, y in pts)
        return f"export const {name}: [number, number][] = [{body}];\n"

    SHAPE_TS.write_text(
        "/* Outline of the Encop mark, measured from the supplied artwork by scripts/make_brand_assets.py.\n"
        "   Generated; do not hand-edit. Coordinates are pixels of encop-mark.png (y points down). */\n"
        f"export const MARK_SIZE = {{ width: {mw}, height: {mh} }} as const;\n"
        f"export const HAND_RECT = {{ x: {hx}, y: {hy}, width: {hand_img.size[0]}, height: {hand_img.size[1]} }} as const;\n"
        + fmt("PANEL_OUTLINE", outline(panel))
        + fmt("STRIPE_OUTLINE", outline(stripe)),
        encoding="utf-8",
    )

    # ---------- the wordmark: white letters, alpha from luminance (used as a CSS mask, so it takes any colour) ----------
    w = full[WORD_BOX[1] : WORD_BOX[3], WORD_BOX[0] : WORD_BOX[2]]
    a = np.clip((w.max(axis=2) - 6) / 235 * 255 * 1.0, 0, 255)
    word_rgba = np.dstack([np.full(w.shape[:2], 255), np.full(w.shape[:2], 255), np.full(w.shape[:2], 255), a]).astype(np.uint8)
    word, _ = tight(word_rgba, pad=2)
    word.save(MASTERS / "encop-wordmark.png")
    word.save(ASSETS / "encop-wordmark.png")
    print("wordmark", word.size)

    # ---------- favicon + touch icon ----------
    def fit(img: Image.Image, box: int, fill: float) -> Image.Image:
        s = box * fill / max(img.size)
        return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)

    for name, size, bg in (("favicon.png", 64, None), ("apple-touch-icon.png", 180, (0, 0, 0, 255))):
        canvas = Image.new("RGBA", (size, size), bg or (0, 0, 0, 0))
        m = fit(mark, size, 0.9 if bg is None else 0.68)
        canvas.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
        canvas.save(PUBLIC / name)


if __name__ == "__main__":
    main()
