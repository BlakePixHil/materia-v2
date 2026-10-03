"""Shared markup helpers used by component previews and screens."""
from icons import icon, status, priority


def attrs(**kw):
    out = []
    for k, v in kw.items():
        if v is None or v is False:
            continue
        k = k.replace("_", "-")
        out.append(k if v is True else f'{k}="{v}"')
    return (" " + " ".join(out)) if out else ""


def state_attrs(state):
    return {"hover": " data-hover data-static", "press": " data-hover data-press data-static", "focus": " data-focus-visible data-static",
            "disabled": " data-disabled aria-disabled=\"true\"", None: "", "": ""}[state]


def btn(label, v="secondary", size=None, ic=None, kbd=None, state=None, trail=None):
    s = f' data-size="{size}"' if size else ""
    i = icon(ic) if ic else ""
    k = "".join(f'<span class="mt-kbd">{x}</span>' for x in (kbd or []))
    t = icon(trail) if trail else ""
    return f'<button class="mt-btn" type="button" data-variant="{v}"{s}{state_attrs(state)}>{i}{label}{t}{k}</button>'


def ibtn(ic, label, v="ghost", size=None, state=None):
    s = f' data-size="{size}"' if size else ""
    return f'<button class="mt-ibtn" type="button" data-variant="{v}"{s} aria-label="{label}" title="{label}"{state_attrs(state)}>{icon(ic)}</button>'


def kbd(*keys):
    return "".join(f'<kbd class="mt-kbd">{k}</kbd>' for k in keys)


def badge(label, tone=None, ic=None):
    t = f' data-tone="{tone}"' if tone else ""
    return f'<span class="mt-badge"{t}>{icon(ic) if ic else ""}{label}</span>'


TYPE_LABEL = {"will": "Will", "poa": "Power of attorney", "probate": "Probate", "loa": "Letters of admin",
              "admin": "Estate admin", "fp": "Family provision", "contest": "Will dispute", "trust": "Testamentary trust"}


def tag(t, label=None):
    return f'<span class="mt-tag" data-type="{t}">{label or TYPE_LABEL[t]}</span>'


DL_ICON = {"overdue": "alert", "today": "flag", "soon": "clock", "upcoming": "calendar", "done": "check"}


def deadline(label, urgency="upcoming"):
    return f'<span class="mt-deadline" data-urgency="{urgency}">{icon(DL_ICON[urgency])}{label}</span>'


def avatar(initials="JP", size=None, hue=None, kind=None):
    a = attrs(data_size=size, data_hue=hue, data_kind=kind)
    if kind == "clerk":
        return f'<span class="mt-avatar"{a} role="img" aria-label="Clerk">{icon("sparkle")}</span>'
    return f'<span class="mt-avatar"{a}>{initials}</span>'


def clerk(size=None):
    return avatar(size=size, kind="clerk")


def cite(label, n=None):
    num = f'<span class="n">{n}</span>' if n else icon("link", "sm")
    return f'<a class="mt-cite" href="#" onclick="return false">{num}{label}</a>'


def check(state="off", label=None, desc=None, disabled=False, hover=False):
    st = {"on": " data-checked", "mixed": " data-indeterminate", "off": ""}[state]
    ic = icon("minus" if state == "mixed" else "check")
    aria = {"on": "true", "mixed": "mixed", "off": "false"}[state]
    d = " data-disabled" if disabled else ""
    h = " data-hover data-static" if hover else ""
    box = f'<span class="mt-check" role="checkbox" aria-checked="{aria}" tabindex="0"{st}{d}{h}>{ic}</span>'
    if label is None:
        return box
    ds = f'<span class="mt-desc">{desc}</span>' if desc else ""
    return f'<label class="mt-choice"{d}>{box}<span>{label}{ds}</span></label>'


def switch(on=False, label=None, disabled=False):
    c = " data-checked" if on else ""
    d = " data-disabled" if disabled else ""
    sw = f'<span class="mt-switch" role="switch" aria-checked="{"true" if on else "false"}" tabindex="0"{c}{d}><span class="mt-switch-thumb"></span></span>'
    return f'<label class="mt-choice"{d}>{sw}<span>{label}</span></label>' if label else sw


def field(label, value=None, placeholder=None, help=None, error=None, state=None, ic=None, suffix=None, optional=False, select=False, size=None):
    st = {"hover": " data-hover data-static", "focus": " data-focus data-static", "invalid": " data-invalid", "disabled": " data-disabled", None: ""}[state]
    if select and state == "focus":
        st = " data-open"
    cls = "mt-input mt-select" if select else "mt-input"
    i = icon(ic) if ic else ""
    v = f'<span class="v">{value}</span>' if value else f'<span class="v ph">{placeholder or ""}</span>'
    sfx = f'<span class="suffix">{suffix}</span>' if suffix else ""
    chev = icon("updown") if select else ""
    sz = f' data-size="{size}"' if size else ""
    opt = ' <span class="mt-opt">Optional</span>' if optional else ""
    lab = f'<span class="mt-label">{label}{opt}</span>' if label else ""
    h = f'<span class="mt-help">{help}</span>' if help and not error else ""
    e = f'<span class="mt-error">{icon("alert", "sm")}{error}</span>' if error else ""
    return f'<label class="mt-field">{lab}<span class="{cls}"{st}{sz}>{i}{v}{sfx}{chev}</span>{h}{e}</label>'


def progress(pct, tone=None, size=None):
    return f'<div class="mt-progress"{attrs(data_tone=tone, data_size=size)} role="progressbar" aria-valuenow="{pct}" aria-valuemin="0" aria-valuemax="100"><div class="mt-progress-bar" style="width:{pct}%"></div></div>'


def tl(state, title, rule, chip, ic=None):
    ic = ic or {"done": "check", "next": "court", "upcoming": "calendar", "overdue": "alert"}[state]
    return f'<div class="mt-tl" data-state="{state}"><span class="node">{icon(ic)}</span><div><div class="tt">{title}</div><div class="rule">{rule}</div></div><div>{chip}</div></div>'


def task(title, sub, right, done=False):
    return f'<div class="mt-task"{" data-done" if done else ""}>{check("on" if done else "off")}<div class="mt-grow"><div class="tt mt-ell">{title}</div><div class="ts mt-ell">{sub}</div></div>{right}</div>'


def suggestion(title, sub, action="Add task"):
    return f'<div class="mt-suggestion">{clerk("sm")}<div class="mt-grow"><div class="tt">{title}</div><div class="ts">{sub}</div></div>{btn("Dismiss", "ghost", "sm")}{btn(action, "ai", "sm")}</div>'


def time_entry(title, sub, hours, amount, src="timer", captured=False, action=True):
    d = ' data-source="captured"' if captured else ""
    a = btn("Accept", "ai", "sm") if captured and action else ibtn("more", "More", size="sm")
    return f'<div class="mt-time"{d}><span class="src">{icon(src)}</span><div class="mt-grow"><div class="tt mt-ell">{title}</div><div class="ts mt-ell">{sub}</div></div><div class="amt"><span>{hours}</span><span>{amount}</span></div>{a}</div>'


def stat(k, v, f="", unit="", ic=None):
    u = f"<small>{unit}</small>" if unit else ""
    return f'<div class="mt-card mt-stat"><div class="k">{icon(ic, "sm") if ic else ""}{k}</div><div class="v">{v}{u}</div><div class="f">{f}</div></div>'


def spark(points="0,22 20,20 40,21 60,15 80,16 100,10 120,12 140,6 160,7", w=160, h=28):
    pts = points.split()
    last = pts[-1].split(",")
    return (f'<svg class="mt-spark" viewBox="0 0 {w} {h}" preserveAspectRatio="none" aria-hidden="true">'
            f'<polygon class="area" points="0,{h} {points} {w},{h}"/><polyline class="line" points="{points}"/>'
            f'<circle class="end" cx="{last[0]}" cy="{last[1]}" r="2.5"/></svg>')


def nav(label, ic, count=None, active=False, dot=None, hover=False):
    a = " data-active" if active else ""
    h = " data-hover data-static" if hover else ""
    lead = f'<span class="mt-dot" style="background:var(--{dot})"></span>' if dot else icon(ic)
    c = f'<span class="mt-nav-count">{count}</span>' if count else ""
    cur = ' aria-current="page"' if active else ""
    return f'<a class="mt-nav" href="#" onclick="return false"{a}{h}{cur}>{lead}<span class="mt-ell">{label}</span>{c}</a>'


def menu_item(label, ic=None, hint=None, highlighted=False, tone=None, disabled=False, selected=False):
    h = " data-highlighted" if highlighted else ""
    t = f' data-tone="{tone}"' if tone else ""
    d = " data-disabled" if disabled else ""
    s = " data-selected" if selected else ""
    i = icon(ic) if ic else ""
    k = f'<span class="hint">{hint}</span>' if hint else ""
    if selected:
        k = f'<span class="hint check">{icon("check")}</span>'
    return f'<div class="mt-menu-item" role="menuitem"{h}{t}{d}{s}>{i}<span>{label}</span>{k}</div>'
