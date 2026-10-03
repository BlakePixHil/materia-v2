"""Litigation markup helpers: court events, orders, chronology, evidence matrix, offers, court book, scenarios."""
from icons import icon
from markup import badge, btn, cite, deadline, tag

LIT_STAGES = ["Instructions", "Summons filed", "Evidence", "Mediation", "Directions", "Hearing", "Judgment", "Costs"]
ISSUES = {"cap": ("C", "Capacity"), "ka": ("K", "Knowledge and approval"), "ui": ("U", "Undue influence"), "need": ("N", "Financial need"), "rel": ("R", "Relationship")}


def lit_stepper(current, stages=LIT_STAGES):
    lis = "".join(f'<li data-state="{"done" if i < current else "current" if i == current else ""}">{s}</li>' for i, s in enumerate(stages))
    return f'<ol class="mt-stepper" style="--n:{len(stages)}">{lis}</ol>'


def court_event(dow, day, mon, title, sub, where, kind="directions", right=""):
    w = "".join(f'<span class="mt-issue">{icon(i, "sm")}{t}</span>' for i, t in where)
    return (f'<div class="mt-court" data-kind="{kind}"><div class="date">{dow}<b>{day}</b>{mon}</div>'
            f'<div><div class="tt">{title}</div><div class="ts">{sub}</div><div class="where">{w}</div></div><div>{right}</div></div>')


def order(no, text, then, chip, flag=False):
    f = " data-flag" if flag else ""
    return f'<div class="mt-order"{f}><span class="no">{no}</span><div><div class="txt">{text}</div><div class="then">{icon("arrow-right", "sm")}{then}</div></div><div>{chip}</div></div>'


def issue(k):
    letter, name = ISSUES[k]
    return f'<span class="mt-issue" title="{name}"><b>{letter}</b>{name}</span>'


def chrono(date, text, sources, issues=(), key=False):
    k = " data-key" if key else ""
    meta = "".join(cite(s) for s in sources) + "".join(issue(i) for i in issues)
    return f'<div class="mt-chrono-item"{k}><span class="d">{date}</span><span class="pin"></span><div><div class="tt">{text}</div><div class="meta">{meta}</div></div></div>'


def strength(level):
    n = {"strong": 3, "moderate": 2, "weak": 1, "gap": 0}[level]
    dots = "".join(f'<i class="{"on" if i < n else ""}"></i>' for i in range(3))
    label = {"strong": "Strong", "moderate": "Moderate", "weak": "Weak", "gap": "Gap"}[level]
    return f'<span class="mt-strength" data-level="{level}">{dots}{label}</span>'


def matrix(rows):
    """rows: [(issue_title, [(element, evidence_html, level)])]"""
    body = ""
    for title, els in rows:
        body += f'<tr><td class="issue" colspan="3">{title}</td></tr>'
        for el, ev, lv in els:
            body += f'<tr><td class="t-2">{el}</td><td>{ev}</td><td style="text-align:right">{strength(lv)}</td></tr>'
    return f'<table class="mt-matrix"><thead><tr><th>Element</th><th>Evidence</th><th style="text-align:right">Strength</th></tr></thead><tbody>{body}</tbody></table>'


def offer(who, date, kind, amount, terms, status, side="theirs", actions=""):
    return (f'<div class="mt-offer" data-side="{side}"><div><div class="who">{who} · {date} · {kind}</div><div class="amt">{amount}</div></div>'
            f'<div class="side">{status}{actions}</div><div class="terms">{terms}</div></div>')


def scenarios(rows, lo, hi):
    """Single-hue bars around a zero line. rows: [(label, sub, value_k)]; sign is shown by side and by the value label."""
    span = hi - lo
    zero = -lo / span * 100
    out = ['<div style="display:grid;grid-template-columns:minmax(0,190px) minmax(0,1fr) 64px;gap:12px 12px;align-items:center">']
    for lab, sub, v in rows:
        left = zero if v >= 0 else zero + v / span * 100
        width = abs(v) / span * 100
        rad = "0 4px 4px 0" if v >= 0 else "4px 0 0 4px"
        val = f"${v:,.0f}k" if v >= 0 else f"−${-v:,.0f}k"
        vcls = "t-1" if v >= 0 else "t-danger"
        tip = f"{val} to client|{lab}"
        out.append(f'<div><div class="label">{lab}</div><div class="caption t-3">{sub}</div></div>'
                   f'<div style="position:relative;height:20px" tabindex="0" data-tip="{tip}" aria-label="{lab}: {val}">'
                   f'<i style="position:absolute;left:{zero:.1f}%;top:-4px;bottom:-4px;width:1px;background:var(--border-strong)"></i>'
                   f'<i style="position:absolute;left:{left:.1f}%;width:{width:.1f}%;top:3px;height:14px;border-radius:{rad};background:var(--icon-brand)"></i></div>'
                   f'<span class="mono {vcls}" style="text-align:right">{val}</span>')
    out.append("</div>")
    return "".join(out)


def bundle_table(sections):
    """sections: [(tab, title, [(no, doc, date, by, pages, flags_html, excluded)])]"""
    rows = ""
    for tab, title, docs in sections:
        rows += f'<tr class="section"><td colspan="6">Tab {tab} · {title}</td></tr>'
        for no, doc, date, by, pages, flags, exc in docs:
            x = " data-excluded" if exc else ""
            rows += f'<tr{x}><td class="tab">{no}</td><td><span class="title">{doc}</span></td><td class="t-3">{date}</td><td class="t-2">{by}</td><td>{flags}</td><td class="pages">{pages}</td></tr>'
    return f'<table class="mt-table mt-bundle"><thead><tr><th>No.</th><th>Document</th><th>Date</th><th>Filed by</th><th></th><th style="text-align:right">Pages</th></tr></thead><tbody>{rows}</tbody></table>'
