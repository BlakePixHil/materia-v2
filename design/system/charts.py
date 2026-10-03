"""Chart helpers: SVG computed from data with one scale per chart. Single series, brand hue, hover tips, table view."""


def _money_k(v):
    return f"${v:,.0f}k" if v >= 10 else f"${v:.1f}k"


def _rounded_top(x, y, w, base, r=4):
    r = min(r, (base - y), w / 2)
    return f"M{x:.1f},{base:.1f}V{y + r:.1f}Q{x:.1f},{y:.1f} {x + r:.1f},{y:.1f}H{x + w - r:.1f}Q{x + w:.1f},{y:.1f} {x + w:.1f},{y + r:.1f}V{base:.1f}Z"


def table_view(headers, rows):
    th = "".join(f'<th{" class=num" if i else ""}>{h}</th>' for i, h in enumerate(headers))
    tr = "".join("<tr>" + "".join(f'<td{" class=num" if i else ""}>{c}</td>' for i, c in enumerate(r)) + "</tr>" for r in rows)
    return f'<details class="mt-tableview"><summary>View as table</summary><table class="mt-table"><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table></details>'


def columns(data, target=None, w=760, h=220, ymax=70, step=20, unit="k", label_idx=()):
    """data: [(label, value_in_k, tip_label)]. Columns from a zero baseline; optional solid target line."""
    l, r, t, b = 44, 12, 18, 26
    pw, ph = w - l - r, h - t - b
    base = t + ph
    y = lambda v: t + ph - v / ymax * ph
    n = len(data)
    band = pw / n
    bw = min(24, band * 0.5)
    out = [f'<svg class="mt-chart" viewBox="0 0 {w} {h}" style="max-width:{w}px" role="img" aria-label="Column chart">']
    for v in range(0, ymax + 1, step):
        yy = y(v)
        out.append(f'<line class="{"base" if v == 0 else "grid"}" x1="{l}" x2="{w - r}" y1="{yy:.1f}" y2="{yy:.1f}"/>')
        out.append(f'<text class="tick" x="{l - 8}" y="{yy + 4:.1f}" text-anchor="end">{"$0" if v == 0 else f"${v}{unit}"}</text>')
    for i, (lab, v, tl) in enumerate(data):
        cx = l + band * i + band / 2
        out.append(f'<rect class="hit" x="{l + band * i:.1f}" y="{t}" width="{band:.1f}" height="{ph}" tabindex="0" data-tip="${v * 1000:,.0f} billed|{tl}" aria-label="{tl}: ${v * 1000:,.0f}"/>')
        out.append(f'<path class="bar" d="{_rounded_top(cx - bw / 2, y(v), bw, base)}" pointer-events="none"/>')
        out.append(f'<text class="tick" x="{cx:.1f}" y="{h - 8}" text-anchor="middle">{lab}</text>')
        if i in label_idx:
            out.append(f'<text class="val" x="{cx:.1f}" y="{y(v) - 6:.1f}" text-anchor="middle">{_money_k(v)}</text>')
    if target is not None:
        ty = y(target)
        out.append(f'<line class="ref" x1="{l}" x2="{w - r}" y1="{ty:.1f}" y2="{ty:.1f}" pointer-events="none"/>')
        out.append(f'<text class="ref-lbl" x="{l + 6}" y="{ty - 6:.1f}">Target ${target}k</text>')
    out.append("</svg>")
    return "".join(out)


def line(data, ref=None, ref_label="", w=560, h=200, ymin=30, ymax=60, step=10, unit=""):
    """data: [(label, value, tip_label)]. 2px line, 10% area wash, end dot with surface ring, end label."""
    l, r, t, b = 36, 56, 14, 26
    pw, ph = w - l - r, h - t - b
    n = len(data)
    x = lambda i: l + i * pw / (n - 1)
    y = lambda v: t + ph - (v - ymin) / (ymax - ymin) * ph
    out = [f'<svg class="mt-chart" viewBox="0 0 {w} {h}" style="max-width:{w}px" role="img" aria-label="Line chart">']
    for v in range(ymin, ymax + 1, step):
        out.append(f'<line class="{"base" if v == ymin else "grid"}" x1="{l}" x2="{w - r}" y1="{y(v):.1f}" y2="{y(v):.1f}"/><text class="tick" x="{l - 8}" y="{y(v) + 4:.1f}" text-anchor="end">{v}</text>')
    pts = " ".join(f"{x(i):.1f},{y(v):.1f}" for i, (_, v, _) in enumerate(data))
    band = pw / (n - 1)
    for i, (lab, v, tl) in enumerate(data):
        hx = max(l, x(i) - band / 2)
        hw = (band / 2) if i in (0, n - 1) else band
        out.append(f'<rect class="hit" x="{hx:.1f}" y="{t}" width="{hw:.1f}" height="{ph}" tabindex="0" data-tip="{v}{unit}|{tl}" aria-label="{tl}: {v}{unit}"/>')
    out.append(f'<path class="area" pointer-events="none" d="M{x(0):.1f},{y(ymin):.1f} L{pts.replace(" ", " L")} L{x(n - 1):.1f},{y(ymin):.1f}Z"/>')
    if ref is not None:
        out.append(f'<line class="ref" x1="{l}" x2="{w - r}" y1="{y(ref):.1f}" y2="{y(ref):.1f}"/><text class="ref-lbl" x="{l + 6}" y="{y(ref) + 14:.1f}">{ref_label}</text>')
    out.append(f'<polyline class="line" points="{pts}" pointer-events="none"/>')
    for i, (lab, v, tl) in enumerate(data):
        if i % 2 == 0 or i == n - 1:
            out.append(f'<text class="tick" x="{x(i):.1f}" y="{h - 8}" text-anchor="middle">{lab}</text>')
    lx, lv = x(n - 1), data[-1][1]
    out.append(f'<circle class="dot" cx="{lx:.1f}" cy="{y(lv):.1f}" r="4" pointer-events="none"/><text class="val" x="{lx + 10:.1f}" y="{y(lv) + 4:.1f}">{lv}{unit}</text>')
    out.append("</svg>")
    return "".join(out)


def hbars(rows, vmax, fmt=lambda v: f"{v}", key=None):
    """rows: [(label_html, value, tip)]. Horizontal bars, square at the baseline, 4px rounded end, value at the tip."""
    out = ['<div class="mt-hbars">']
    for lab, v, tip in rows:
        pct = v / vmax * 100
        out.append(f'<span class="k">{lab}</span><div class="track" tabindex="0" data-tip="{fmt(v)}|{tip}" aria-label="{tip}: {fmt(v)}"><div class="fill" style="width:{pct:.1f}%"></div></div><span class="v">{fmt(v)}</span>')
    out.append("</div>")
    return "".join(out)
