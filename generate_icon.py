"""
SAP Auditor — App Icon Generator
1024×1024 px, matches the reference design:
  - Dark navy rounded-square background
  - 3×3 grid of rounded-rect data cells
  - One blue "flagged" cell with a dash
  - One amber warning triangle cell
  - White corner-bracket scan decorators
"""

from PIL import Image, ImageDraw
import math
import os

SIZE = 1024
OUT = os.path.join(os.path.dirname(__file__), "public", "icon-1024.png")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

# ── Colours ──────────────────────────────────────────────────────────────────
BG_OUTER   = (10,  14,  26)        # very dark navy (canvas)
BG_CARD    = (16,  24,  44)        # card background
BG_CARD_H  = (22,  32,  58)        # slightly lighter centre glow

CELL_LIGHT = (148, 163, 184)       # slate-400  — top row
CELL_MID   = ( 71,  85, 105)       # slate-600  — middle / bottom rows
CELL_DARK  = ( 51,  65,  85)       # slate-700  — bottom row

BLUE       = ( 59, 130, 246)       # blue-500   — flagged cell
AMBER      = (245, 158,  11)       # amber-500  — warning badge
WHITE      = (248, 250, 252)       # near-white
SHADOW     = (  0,   0,   0,  80)  # translucent shadow


def rounded_rect(draw, xy, radius, fill, shadow_offset=0):
    """Draw a rounded rectangle, optionally with a soft drop shadow."""
    x0, y0, x1, y1 = xy
    if shadow_offset:
        sx, sy = x0 + shadow_offset, y0 + shadow_offset
        draw.rounded_rectangle([sx, sy, x1 + shadow_offset, y1 + shadow_offset],
                               radius=radius, fill=(0, 0, 0, 60))
    draw.rounded_rectangle(xy, radius=radius, fill=fill)


def draw_warning_triangle(draw, cx, cy, size, color, stroke_color):
    """Draw a filled warning triangle with a '!' in the centre."""
    h = int(size * math.sqrt(3) / 2)
    pts = [
        (cx,          cy - h * 2 // 3),
        (cx - size,   cy + h // 3),
        (cx + size,   cy + h // 3),
    ]
    draw.polygon(pts, fill=color)
    # thin dark border
    draw.polygon(pts, outline=stroke_color, width=max(2, size // 18))
    # exclamation mark body
    bar_w  = max(3, size // 7)
    bar_h1 = int(h * 0.34)
    bar_h2 = int(h * 0.12)
    bar_top = cy - h * 2 // 3 + int(h * 0.22)
    draw.rounded_rectangle(
        [cx - bar_w, bar_top, cx + bar_w, bar_top + bar_h1],
        radius=bar_w, fill=stroke_color
    )
    dot_r = bar_w + 1
    dot_y = bar_top + bar_h1 + int(h * 0.07)
    draw.ellipse([cx - dot_r, dot_y, cx + dot_r, dot_y + bar_h2 * 2],
                 fill=stroke_color)


def make_icon():
    img  = Image.new("RGBA", (SIZE, SIZE), BG_OUTER)
    draw = ImageDraw.Draw(img, "RGBA")

    # ── Background card (rounded square) ────────────────────────────────────
    pad   = int(SIZE * 0.04)
    r_card = int(SIZE * 0.18)
    draw.rounded_rectangle([pad, pad, SIZE - pad, SIZE - pad],
                            radius=r_card, fill=BG_CARD)

    # subtle radial centre highlight — paint a slightly lighter oval
    hl = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    hl_draw = ImageDraw.Draw(hl)
    hl_draw.ellipse([SIZE//4, SIZE//5, SIZE*3//4, SIZE*4//5],
                    fill=(*BG_CARD_H, 120))
    img = Image.alpha_composite(img, hl)
    draw = ImageDraw.Draw(img, "RGBA")

    # ── Corner brackets ──────────────────────────────────────────────────────
    br_pad   = int(SIZE * 0.115)   # distance from card edge
    br_len   = int(SIZE * 0.095)   # arm length
    br_thick = int(SIZE * 0.018)   # line thickness
    br_r     = int(br_thick * 0.8)
    corners = [
        (br_pad,          br_pad,          +1, +1),   # top-left
        (SIZE - br_pad,   br_pad,          -1, +1),   # top-right
        (br_pad,          SIZE - br_pad,   +1, -1),   # bottom-left
        (SIZE - br_pad,   SIZE - br_pad,   -1, -1),   # bottom-right
    ]
    for cx, cy, dx, dy in corners:
        # horizontal arm (normalise so x0 <= x1)
        hx0 = min(cx, cx + dx * br_len)
        hx1 = max(cx, cx + dx * br_len)
        draw.rounded_rectangle(
            [hx0, cy - br_thick//2, hx1, cy + br_thick//2],
            radius=br_r, fill=WHITE
        )
        # vertical arm (normalise so y0 <= y1)
        vy0 = min(cy, cy + dy * br_len)
        vy1 = max(cy, cy + dy * br_len)
        draw.rounded_rectangle(
            [cx - br_thick//2, vy0, cx + br_thick//2, vy1],
            radius=br_r, fill=WHITE
        )

    # ── 3×3 cell grid ────────────────────────────────────────────────────────
    cols, rows = 3, 3
    grid_w  = int(SIZE * 0.52)
    grid_h  = int(SIZE * 0.52)
    gap     = int(SIZE * 0.022)
    cell_w  = (grid_w - gap * (cols - 1)) // cols
    cell_h  = (grid_h - gap * (rows - 1)) // rows
    cell_r  = int(cell_w * 0.16)
    gx0     = (SIZE - grid_w) // 2
    gy0     = (SIZE - grid_h) // 2 - int(SIZE * 0.01)

    # Colour map per cell [row][col]
    cell_colors = [
        [CELL_LIGHT,  CELL_LIGHT,  (120, 132, 155)],   # row 0 — light
        [CELL_MID,    BLUE,        AMBER          ],   # row 1 — flagged row
        [(80, 95,115), CELL_DARK,  CELL_MID       ],   # row 2 — dark
    ]

    for r in range(rows):
        for c in range(cols):
            x0 = gx0 + c * (cell_w + gap)
            y0 = gy0 + r * (cell_h + gap)
            x1, y1 = x0 + cell_w, y0 + cell_h
            color = cell_colors[r][c]

            # skip amber cell — drawn as warning triangle below
            if r == 1 and c == 2:
                continue

            rounded_rect(draw, [x0, y0, x1, y1], cell_r, color,
                         shadow_offset=int(SIZE * 0.005))

    # ── Dash on blue cell ────────────────────────────────────────────────────
    bc = 1   # row 1, col 1
    bx0 = gx0 + bc * (cell_w + gap)
    by0 = gy0 + 1  * (cell_h + gap)
    bx1, by1 = bx0 + cell_w, by0 + cell_h
    dash_w = int(cell_w * 0.44)
    dash_h = int(cell_h * 0.16)
    dcx, dcy = (bx0 + bx1) // 2, (by0 + by1) // 2
    draw.rounded_rectangle(
        [dcx - dash_w//2, dcy - dash_h//2,
         dcx + dash_w//2, dcy + dash_h//2],
        radius=dash_h//2, fill=WHITE
    )

    # ── Warning triangle cell (row 1, col 2) ─────────────────────────────────
    wc = 2
    wx0 = gx0 + wc * (cell_w + gap)
    wy0 = gy0 + 1  * (cell_h + gap)
    wx1, wy1 = wx0 + cell_w, wy0 + cell_h
    # amber background pill
    rounded_rect(draw, [wx0, wy0, wx1, wy1], cell_r, AMBER)
    # triangle
    tri_cx = (wx0 + wx1) // 2
    tri_cy = (wy0 + wy1) // 2 + int(cell_h * 0.03)
    tri_sz = int(cell_w * 0.38)
    draw_warning_triangle(draw, tri_cx, tri_cy, tri_sz,
                          color=(255, 215, 50),
                          stroke_color=(40, 22, 0))

    # ── Save ─────────────────────────────────────────────────────────────────
    img.save(OUT, "PNG")
    print(f"Saved → {OUT}  ({SIZE}×{SIZE} px)")


if __name__ == "__main__":
    make_icon()
