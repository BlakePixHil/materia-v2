"""materia tokens: palette.py + type, space, radius, shadow and size.

Writes project/tokens.json (the design-system format) and
design/tokens/materia.tokens.css (the same names as CSS custom properties, for Angular).
"""
import json
from palette import P, S, hexof

THEMES = [{"id": "light", "name": "Light"}, {"id": "dark", "name": "Dark"}]

PRIMITIVE_USAGE = {
    "slate": "Cool neutral scale. Use through the bg-, text-, border- and icon- tokens, not directly.",
    "blue": "Brand scale. blue-500 #346CFC is the primary.",
    "violet": "Clerk (AI) scale. Reserved for Clerk.",
    "orange": "End of the Clerk gradient; Letters of administration tag.",
    "green": "Success scale.",
    "amber": "Warning scale; Probate tag.",
    "red": "Danger scale; Family provision tag.",
    "teal": "Information scale; Power of attorney tag.",
    "rose": "Will dispute tag only.",
}

SPACE = [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64]
SPACE_USAGE = {
    0: "Flush.", 2: "Icon-to-label nudge, stacked avatars.", 4: "Gap inside chips and badges.",
    6: "Gap inside buttons and tags.", 8: "Default inline gap; menu padding.", 12: "Control padding; gap between related cards.",
    16: "Card padding; gap between card groups.", 20: "Panel padding.", 24: "Page section gap.",
    32: "Page gutter in the main panel.", 40: "Large section spacing.", 48: "Empty-state spacing.", 64: "Page top spacing on wide screens.",
}
RADIUS = [("radius-xs", "4px", "Badges, tags, kbd, checkboxes."), ("radius-sm", "6px", "Buttons, inputs, menu items, nav items."),
          ("radius-md", "8px", "Menus, popovers, inner cards."), ("radius-lg", "10px", "Cards, dialogs, toasts."),
          ("radius-xl", "14px", "The inset main panel."), ("radius-full", "999px", "Avatars, pills, switches, status dots.")]
SHADOW = [
    ("shadow-control", {"light": "0 1px 2px rgba(16, 18, 24, 0.06)", "dark": "0 1px 2px rgba(0, 0, 0, 0.5)"}, "Secondary buttons and raised segmented items."),
    ("shadow-card", {"light": "0 1px 2px rgba(16, 18, 24, 0.04)", "dark": "0 1px 2px rgba(0, 0, 0, 0.4)"}, "Cards and the inset main panel."),
    ("shadow-popover", {"light": "0 0 0 1px rgba(16, 18, 24, 0.06), 0 8px 24px -6px rgba(16, 18, 24, 0.16)", "dark": "0 0 0 1px rgba(255, 255, 255, 0.07), 0 12px 32px -8px rgba(0, 0, 0, 0.72)"}, "Menus, tooltips, selects, toasts."),
    ("shadow-dialog", {"light": "0 0 0 1px rgba(16, 18, 24, 0.06), 0 24px 64px -16px rgba(16, 18, 24, 0.32)", "dark": "0 0 0 1px rgba(255, 255, 255, 0.08), 0 24px 64px -12px rgba(0, 0, 0, 0.8)"}, "Dialogs and the command palette."),
    ("focus-ring", {"light": "0 0 0 2px #FFFFFF, 0 0 0 4px #346CFC", "dark": "0 0 0 2px #111216, 0 0 0 4px #6690FD"}, "Keyboard focus on every interactive element ([data-focus-visible]). Solid, at least 3:1 on every surface."),
    ("ai-glow", {"light": "0 8px 24px -10px rgba(124, 92, 255, 0.45)", "dark": "0 8px 28px -10px rgba(124, 92, 255, 0.55)"}, "Clerk composer and the morning brief only."),
]
SIZE = [("control-sm", "28px", "Small buttons, compact inputs, table actions."), ("control-md", "32px", "Default button, input, select and nav item height."),
        ("control-lg", "36px", "Primary page actions and the composer send area."), ("row", "40px", "Table and list row height."),
        ("topbar", "48px", "Main panel top bar."), ("sidebar", "240px", "Sidebar width."), ("icon-sm", "14px", "Icons in chips and badges."), ("icon", "16px", "Default icon size.")]

# Stacking order for overlays (FND-09). Everything portals into one overlay container; later layers
# sit above earlier ones, so a tooltip shows over a menu that is over a dialog.
LAYER = [("layer-sticky", "100", "Sticky headers and the app shell's bars."), ("layer-dropdown", "1000", "Menus, selects and popovers."),
         ("layer-overlay", "1100", "The scrim behind a dialog or sheet."), ("layer-modal", "1200", "Dialogs, sheets and the command palette."),
         ("layer-popover", "1300", "Menus and popovers opened from inside a dialog."), ("layer-toast", "1400", "Toasts."),
         ("layer-tooltip", "1500", "Tooltips, above everything.")]

FONTS = [{"family": "Geist", "file": "fonts/Geist-Variable.woff2", "weight": "100 900", "style": "normal"},
         {"family": "Geist Mono", "file": "fonts/GeistMono-Variable.woff2", "weight": "100 900", "style": "normal"}]
FAMILIES = {"sans": '"Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
            "mono": '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace'}
# name, size, line-height, weight, tracking, family, sample, usage
TYPE = [
    ("Interface", "sans", [
        ("display", "32px", "38px", 600, "-0.025em", None, "Good morning, Jordan.", "The one greeting or hero line on a page. At most one per view."),
        ("title-l", "24px", "30px", 600, "-0.02em", None, "Estate of Margaret Whitfield", "Page titles: the matter name, Matters, Time and billing."),
        ("title-m", "18px", "24px", 600, "-0.015em", None, "Three things need you today", "Dialog titles and Clerk brief headings."),
        ("heading", "14px", "20px", 600, "-0.005em", None, "Statutory deadlines", "Card and section headings."),
        ("body-l", "15px", "24px", 400, "0", None, "The binding nomination lapsed in March 2024, so the trustee may pay it to the estate.", "Long-form reading: Clerk answers, file notes, advice drafts."),
        ("body", "14px", "20px", 400, "0", None, "Send estate asset questionnaire to executors", "Default text: task titles, table values, form values."),
        ("body-s", "13px", "18px", 400, "0", None, "A&P Rules 2014 · at least 14 days before filing", "Secondary lines under a title; dense tables."),
        ("label", "13px", "18px", 500, "0", None, "Record time", "Buttons, nav items, field labels, tabs."),
        ("label-s", "12px", "16px", 500, "0", None, "In 5 days", "Badges, tags, deadline chips, small buttons."),
        ("caption", "12px", "16px", 400, "0", None, "Read across 14 matters, 37 emails and your calendar", "Timestamps, helper text, footnotes."),
        ("numeric-xl", "28px", "32px", 600, "-0.02em", None, "$42,860", "KPI values. Always tabular figures."),
        ("numeric-m", "16px", "20px", 600, "-0.01em", None, "18.4 h", "Inline totals and small stats. Tabular figures."),
    ]),
    ("Data", "mono", [
        ("eyebrow", "11px", "14px", 500, "0.04em", None, "WE-142 · PROBATE · VIC", "Uppercase micro-labels above titles and table headers."),
        ("mono", "13px", "18px", 400, "0", None, "0.4 h  $176.00", "Amounts, hours and refs in tables. Tabular by default."),
        ("mono-s", "11px", "14px", 500, "0", None, "WE-142", "Matter refs, counts, kbd hints, citations."),
    ]),
]


def tokens_json():
    colors = []
    for fam, steps in P.items():
        for step, hx in steps.items():
            colors.append({"name": f"{fam}-{step}", "value": hx.lower(), "usage": PRIMITIVE_USAGE[fam]})
    for name, l, d, usage in S:
        colors.append({"name": name, "value": {"light": "{%s}" % l, "dark": "{%s}" % d}, "usage": usage})
    groups = []
    for gname, fam, styles in TYPE:
        groups.append({"name": gname, "family": fam, "styles": [
            {"name": n, "fontSize": fs, "lineHeight": lh, "fontWeight": fw, "letterSpacing": ls, "sample": sm, "usage": u}
            for n, fs, lh, fw, ls, _, sm, u in styles]})
    return {
        "name": "materia", "version": 2,
        "color": {"themes": THEMES, "tokens": colors},
        "type": {"fonts": FONTS, "families": FAMILIES, "groups": groups},
        "spacing": {"tokens": [{"name": f"space-{s}", "value": f"{s}px", "usage": SPACE_USAGE[s]} for s in SPACE]},
        "radius": {"tokens": [{"name": n, "value": v, "usage": u} for n, v, u in RADIUS]},
        "shadow": {"tokens": [{"name": n, "value": v, "usage": u} for n, v, u in SHADOW]},
        "size": {"tokens": [{"name": n, "value": v, "usage": u} for n, v, u in SIZE]},
        "layer": {"tokens": [{"name": n, "value": v, "usage": u} for n, v, u in LAYER]},
    }


def tokens_css(system_pref=True, font_base=None):
    """Compile to CSS the way the design-system page does, plus an OS-preference block for apps."""
    light, dark = [], []
    for fam, steps in P.items():
        for step, hx in steps.items():
            light.append(f"--{fam}-{step}: {hx};")
    for name, l, d, _ in S:
        light.append(f"--{name}: var(--{l});")
        dark.append(f"--{name}: var(--{d});")
    for n, v, _ in SHADOW:
        light.append(f"--{n}: {v['light']};")
        dark.append(f"--{n}: {v['dark']};")
    rest = [f"--space-{s}: {s}px;" for s in SPACE] + [f"--{n}: {v};" for n, v, _ in RADIUS] + [f"--{n}: {v};" for n, v, _ in SIZE]
    rest += [f"--{n}: {v};" for n, v, _ in LAYER]
    rest += [f"--font-{k}: {v};" for k, v in FAMILIES.items()]
    ind = "\n  "
    out = ["/* materia tokens v2. Generated by design/system/build.py from palette.py + tokens.py; do not edit by hand. */",
           ":root, [data-theme=\"light\"] {" + ind + ind.join(light) + "\n}",
           "[data-theme=\"dark\"] {" + ind + ind.join(dark) + "\n  color-scheme: dark;\n}"]
    if font_base is not None:
        for f in FONTS:
            fam, fname, wt = f["family"], f["file"].split("/")[-1], f["weight"]
            out.append(f'@font-face {{ font-family: "{fam}"; src: url("{font_base}{fname}") format("woff2"); font-weight: {wt}; font-style: normal; font-display: swap; }}')
    if system_pref:
        out.append("@media (prefers-color-scheme: dark) {\n  :root:not([data-theme=\"light\"]) {" + "\n    " + "\n    ".join(dark) + "\n    color-scheme: dark;\n  }\n}")
    out.append(":root {" + ind + ind.join(rest) + "\n}")
    for _, fam, styles in TYPE:
        for n, fs, lh, fw, ls, _, _, _ in styles:
            extra = " text-transform: uppercase;" if n == "eyebrow" else ""
            tab = " font-variant-numeric: tabular-nums;" if n.startswith(("numeric", "mono")) else ""
            out.append(f".{n} {{ font-family: var(--font-{fam}); font-size: {fs}; line-height: {lh}; font-weight: {fw}; letter-spacing: {ls};{tab}{extra} }}")
    return "\n".join(out) + "\n"
