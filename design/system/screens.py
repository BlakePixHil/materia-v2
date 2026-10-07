"""Full-page screens built from the component classes. Each is a 1440px-wide app frame."""
from icons import icon, status, priority
from markup import *

WHITFIELD_HINT = "Publish the notice today so filing can open 16 Oct."


def sidebar(active):
    items = [("today", "Today", "today", None), ("inbox", "Inbox", "inbox", "3")]
    work = [("matters", "Matters", "matters", "42"), ("deadlines", "Deadlines", "calendar", "9"), ("billing", "Time and billing", "billing", None),
            ("insights", "Insights", "insights", None), ("disputes", "Disputes", "court", "3"), ("contacts", "Contacts", "contacts", None)]
    pins = [("Estate of Margaret Whitfield", "matter-probate"), ("Nguyen v Nguyen", "matter-fp"), ("Harriet and Paul Okafor", "matter-will")]
    h = ['<aside class="mt-sidebar">',
         '<div class="mt-row" style="gap:4px"><div class="mt-ws mt-grow">' + avatar("HP", "sm", kind="org") + '<span class="mt-ell">Hale &amp; Price</span>' + icon("chevron-down") + "</div>" + ibtn("compose", "New matter (C)", size="sm") + "</div>",
         '<div style="padding:4px 0 8px"><span class="mt-input mt-search" data-size="sm">' + icon("search") + '<span class="v">Search…</span>' + kbd("⌘", "K") + "</span></div>"]
    h += [nav(l, i, c, k == active) for k, l, i, c in items]
    h.append('<div class="mt-nav-section">Workspace</div>')
    h += [nav(l, i, c, k == active) for k, l, i, c in work]
    h.append(nav_toggle("Pinned"))
    h += [nav(n, None, dot=d) for n, d in pins]
    h.append('<div style="margin-top:auto;display:flex;flex-direction:column;gap:6px;padding-top:16px">'
             '<button class="mt-btn" data-variant="ai" style="justify-content:flex-start;width:100%">' + icon("sparkle") + 'Ask Clerk<span class="mt-ml">' + kbd("⌘", "J") + "</span></button>"
             '<div class="mt-row" style="padding:6px 6px 0">' + avatar("JP", "sm") + '<span class="label mt-grow mt-ell">Jordan Price</span>' + ibtn("settings", "Settings", size="sm") + "</div></div>")
    h.append("</aside>")
    return "".join(h)


def frame(active, crumbs, actions, page, overlay="", minh=900, side=None):
    cr = []
    for n, c in enumerate(crumbs):
        if n:
            cr.append(icon("chevron-right"))
        last = n == len(crumbs) - 1
        cls = ' class="ref"' if c.startswith("WE-") else ""
        cr.append(f'<span{cls}{" aria-current=page" if last else ""}>{c}</span>')
    top = f'<div class="mt-topbar"><nav class="mt-crumbs" aria-label="Breadcrumb">{"".join(cr)}</nav><div class="mt-ml mt-row" style="gap:6px">{actions}{ibtn("bell", "Notifications", size="sm")}</div></div>'
    return (f'<div class="mt-app mt" style="width:1440px;min-height:{minh}px;position:relative">{side or sidebar(active)}'
            f'<main class="mt-main">{top}{page}</main>{overlay}</div>')


def section_h(title, right=""):
    return f'<div class="mt-card-h"><h3>{title}</h3><span class="mt-ml">{right}</span></div>'


# ------------------------------------------------------------------ Today
def today():
    brief = ('<div class="mt-clerk-card"><div class="in"><div class="mt-clerk-head">' + clerk("sm") + 'Morning brief · 7:42 am<span class="mt-ml mt-row" style="gap:4px">' + btn("Sources", "ghost", "sm", "link") + btn("Ask a follow-up", "ai", "sm", "sparkle") + "</span></div>"
             + '<div class="title-m">Three things need you today</div><div class="mt-col" style="gap:0">'
             + "".join(f'<div class="mt-row" style="align-items:flex-start;gap:12px;padding:12px 0;border-top:1px solid var(--border-subtle)">{icon(ic, None, "t-" + tone)}<div class="mt-grow mt-col" style="gap:6px"><div class="body t-2"><b class="t-1">{m}</b> {txt}</div><div class="mt-cites">{cs}</div></div>{btn(a, "secondary", "sm")}</div>' for ic, tone, m, txt, cs, a in [
                 ("alert", "danger", "Nguyen v Nguyen.", "Service of the plaintiff’s affidavit was due Wednesday. I’ve drafted a consent-extension letter to the other side.", cite("Orders 12 Sep · para 3", 1) + cite("Email · K. Ho 30 Sep", 2), "Review draft"),
                 ("court", "brand", "Whitfield.", "The caveat search came back clear. Publish the probate notice today and the application can be filed in RedCrest from 16 Oct.", cite("A&amp;P Rules 2014", 3) + cite("Caveat search · 1 Oct", 4), "Open matter"),
                 ("draft", "warning", "Okafor.", "Thursday’s will signing still needs a second witness.", cite("Wills Act 1997 (Vic) s 7", 5), "Add task")])
             + '</div><div class="mt-clerk-foot">Read 14 active matters, 37 emails and your calendar. Clerk can be wrong; check the citations.</div></div></div>')
    deadlines = ('<div class="mt-card" data-pad>' + section_h("Deadlines this week", btn("All deadlines", "ghost", "sm", trail="arrow-right")) + '<div class="mt-timeline">'
                 + tl("overdue", 'Serve plaintiff’s affidavit <span class="t-3">· Nguyen v Nguyen</span>', "Court orders 12 Sep · County Court of Victoria", deadline("Overdue 2d", "overdue"))
                 + tl("next", 'Publish notice of intended application <span class="t-3">· Whitfield</span>', "<code>A&amp;P Rules 2014</code> · at least 14 days before filing", deadline("Today", "today"))
                 + tl("upcoming", 'Will and EPA signing <span class="t-3">· Okafor</span>', "Office · 10:00 am · two witnesses", deadline("Thu 8 Oct", "soon"), "draft")
                 + tl("upcoming", 'Return signed EPA <span class="t-3">· Alan Brooks</span>', "Client follow-up", deadline("Fri 9 Oct", "upcoming"), "document") + "</div></div>")
    tasks = ('<div class="mt-card" data-pad>' + section_h('My tasks <span class="mt-count">6</span>', btn("New task", "ghost", "sm", "plus")) + '<div class="mt-col" style="gap:2px;margin:0 -8px">'
             + task("Send estate asset questionnaire to executors", "WE-142 · Estate of Margaret Whitfield", deadline("Today", "today") + avatar("JP"))
             + task("Search for next of kin for the Fairweather intestacy", "WE-133 · intestacy · APA 1958 Pt I Div 6", deadline("Mon 12 Oct", "upcoming") + avatar("PS", hue="2"))
             + task("Book will and EPA signing room for Thursday", "WE-151 · Harriet and Paul Okafor", deadline("Thu 8 Oct", "soon") + avatar("JP"))
             + task("Call Peter Hale about the share registry statements", "WE-118 · Estate of Robert Chen", deadline("Wed 7 Oct", "upcoming") + avatar("PS", hue="2"))
             + task("Obtain original will from safe custody", "WE-160 · Estate of George Lambert", deadline("Done", "done") + avatar("JP"), True)
             + '</div><div style="margin-top:2px">' + suggestion("Request date-of-death valuation for 14 Ashby St, Newtown", "Clerk · from will cl. 4(b) and the title search") + "</div></div>")
    right = ('<div class="mt-col" style="gap:12px">'
             + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
             + stat("Billable this week", "18.4", progress(74) + '<span class="mono-s">/ 25 h</span>', " h")
             + stat("Work in progress", "$42.9k", '<span class="mt-delta" data-dir="up">▲ $6.1k</span> this week')
             + stat("Unbilled 30+ days", "$11.2k", "3 matters")
             + stat("Deadlines in Oct", "9", '<span class="t-danger">1 overdue</span>') + "</div>"
             + deadlines
             + '<div class="mt-card" data-pad>' + section_h("Time to review", badge("2.1 h", "ai", "sparkle")) + '<p class="caption t-3" style="margin:-4px 0 0">Drafted from yesterday’s email, calls and documents. Nothing bills until you accept it.</p>'
             + time_entry("Emails with executor re: assets", "3 emails · WE-142", "0.4 h", "$176.00", "mail", True, False)
             + time_entry("Letter re: extension of time", "Word · 34 min · WE-097", "0.6 h", "$264.00", "draft", True, False)
             + '<div class="mt-row">' + btn("Review 6 entries", "secondary", "sm") + '<span class="mt-ml">' + btn("Accept all", "ai", "sm") + "</span></div></div>"
             + "</div>")
    page = (f'<div class="mt-page"><div class="mt-row" style="align-items:flex-end"><div class="mt-col" style="gap:6px"><span class="eyebrow t-3">Friday 2 October</span><h1 class="display" style="margin:0">Good morning, Jordan</h1></div></div>'
            f'<div style="display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:20px;align-items:start"><div class="mt-col" style="gap:16px">{brief}{tasks}</div>{right}</div></div>')
    return frame("today", ["Today"], btn("Record time", "secondary", "sm", "timer", ["T"]) + btn("New matter", "primary", "sm", "plus", ["C"]), page)


# ------------------------------------------------------------------ Matter
STAGES = ["Intake", "Will & assets", "Notice", "Filed", "Grant", "Collect", "Debts & tax", "Distribute", "Finalise"]


def matter():
    comp_ = [("Real property", 82.7, "$2.35m", "matter-will"), ("Shares", 8.5, "$241k", "matter-poa"), ("Cash", 6.5, "$186k", "matter-admin"), ("Other", 2.3, "$64k", "matter-trust")]
    bar = '<div style="display:flex;gap:2px;height:8px;border-radius:999px;overflow:hidden">' + "".join(f'<i style="width:{p}%;background:var(--{c})"></i>' for _, p, _, c in comp_) + "</div>"
    legend = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 20px">' + "".join(f'<div class="mt-row body-s"><i style="width:8px;height:8px;border-radius:2px;background:var(--{c})"></i><span class="t-2 mt-grow">{n}</span><span class="mono">{v}</span></div>' for n, _, v, c in comp_) + "</div>"
    parties = "".join(f'<div class="mt-row" style="gap:10px;padding:6px 0">{avatar(a, "lg", hue=h)}<div class="mt-grow"><div class="label">{n}</div><div class="caption t-3">{r}</div></div>{x}</div>' for a, n, r, h, x in [
        ("CW", "Catherine Whitfield", "Executor · daughter · 50%", None, ""), ("PH", "Peter Hale", "Executor · accountant", "2", ""),
        ("GT", "Grandchildren’s trust", "Beneficiary · 30%", "4", ""), ("TW", "Thomas Whitfield", "Son · not provided for (cl. 6)", "risk", badge("FP risk", "danger"))])
    left = ('<div class="mt-page" style="padding-right:28px">'
            + '<div class="mt-col" style="gap:10px"><div class="mt-row" style="gap:8px">' + status("active", .25) + '<span class="mono-s t-3">WE-142</span>' + tag("probate") + badge("Notice period", "brand") + priority("high") + '<span class="caption t-3">Supreme Court of Victoria</span></div>'
            + '<h1 class="title-l" style="margin:0">Estate of Margaret Whitfield</h1>'
            + '<ol class="mt-stepper" style="margin-top:6px">' + "".join(f'<li data-state="{"done" if i < 2 else "current" if i == 2 else ""}">{s}</li>' for i, s in enumerate(STAGES)) + "</ol></div>"
            + '<div class="mt-tabs">' + "".join(f'<button class="mt-tab"{" data-active" if i == 0 else ""}>{t}{f"<span class=mt-count>{n}</span>" if n else ""}</button>' for i, (t, n) in enumerate([("Overview", None), ("Deadlines", 6), ("Estate", None), ("Parties", 9), ("Documents", 23), ("Time", None), ("Activity", None)])) + "</div>"
            + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">'
            + '<div class="mt-card" data-pad>' + section_h("Key facts", btn("Edit", "ghost", "sm")) + '<dl class="mt-facts"><dt>Deceased</dt><dd>Margaret Anne Whitfield</dd><dt>Date of death</dt><dd>22 Jul 2026 · aged 81</dd><dt>Last address</dt><dd>14 Ashby St, Newtown VIC 3220</dd><dt>Will</dt><dd>3 May 2019 · original held</dd><dt>Executors</dt><dd>Catherine Whitfield, Peter Hale</dd><dt>Fee arrangement</dt><dd>Hourly · $440 · estimate $18,000</dd></dl></div>'
            + '<div class="mt-card" data-pad>' + section_h("Estate", '<span class="numeric-m">$2.84m</span>') + bar + legend + '<div class="mt-note">' + icon("info") + "<span>Super of $412k sits outside the estate. The binding nomination lapsed in March 2024, so the trustee may pay it to the estate.</span></div></div>"
            + '<div class="mt-card" data-pad>' + section_h("Statutory deadlines", btn("Add", "ghost", "sm", "plus")) + '<div class="mt-timeline">'
            + tl("done", "Caveat search: none lodged", "RedCrest · 1 Oct", deadline("Done", "done"))
            + tl("next", "Publish notice of intended application", "<code>A&amp;P Rules 2014</code> · 14 days before filing", deadline("Today", "today"))
            + tl("upcoming", "File probate application", "RedCrest · from 16 Oct", deadline("16 Oct", "upcoming"))
            + tl("upcoming", "Family provision window ends", "<code>APA 1958 (Vic) s 99</code> · 6 months from the grant", badge("No grant yet"), "scale") + "</div></div>"
            + '<div class="mt-card" data-pad>' + section_h("Parties", btn("Family tree", "ghost", "sm", "family-tree")) + '<div class="mt-col" style="gap:0">' + parties + "</div></div>"
            + "</div></div>")
    clerk_panel = ('<aside style="width:400px;flex:none;border-left:1px solid var(--border-default);display:flex;flex-direction:column;background:linear-gradient(180deg,var(--bg-ai-subtle),var(--bg-surface) 160px)">'
                   + '<div class="mt-row" style="height:48px;padding:0 8px 0 16px;border-bottom:1px solid var(--border-default)">' + clerk("sm") + '<span class="label">Clerk</span><span class="caption t-3">Reading WE-142 · 23 documents</span><span class="mt-ml">' + ibtn("x", "Close Clerk", size="sm") + "</span></div>"
                   + '<div class="mt-col" style="gap:18px;padding:20px 16px;flex:1">'
                   + '<div class="mt-msg" data-role="user">Is anyone likely to bring a family provision claim?</div>'
                   + '<div class="mt-msg" data-role="clerk">' + clerk("sm") + '<div class="body"><p><b>Most likely Thomas Whitfield, the son.</b> He is an eligible person under s 90 as her child, and clause 6 of the will leaves him nothing, citing estrangement since 2011.<sup>1 2</sup></p><p>Two things to know:</p><ul><li>The file note of 14 Aug records Thomas asking Catherine for a copy of the will.<sup>4</sup></li><li>The $412k super sits outside the estate. Victoria has no notional estate, so a claim reaches only the $2.84m estate.<sup>3</sup></li></ul><p>He has <b>6 months from the grant</b> to apply (s 99). Hold any distribution until then (s 99A).</p><div class="mt-cites">'
                   + cite("Will · cl. 6", 1) + cite("APA 1958 (Vic) s 90", 2) + cite("Super statement p 2", 3) + cite("File note 14 Aug", 4) + '</div><div class="mt-row">' + btn("Add risk flag", "secondary", "sm", "flag") + btn("Draft advice to executors", "ai", "sm", "sparkle") + "</div></div></div>"
                   + '<div class="mt-col" style="gap:6px;margin-top:auto;align-items:flex-start"><span class="caption t-3">Try asking</span>' + "".join(f'<button class="mt-chip">{icon("sparkle")}{q}</button>' for q in ["When can we safely distribute?", "Summarise the will in plain English", "What’s still missing for the probate application?"]) + "</div></div>"
                   + '<div style="padding:0 12px 12px"><div class="mt-composer"><span class="ctx">' + icon("matters") + "WE-142 · Whitfield" + icon("x") + '</span><div class="field">Ask about this estate…</div><div class="bar">' + ibtn("attach", "Attach", size="sm") + ibtn("mic", "Dictate", size="sm") + '<span class="mt-grow"></span><button class="mt-send" aria-label="Send">' + icon("send") + "</button></div></div></div></aside>")
    page = f'<div style="display:flex;flex:1;min-height:0">{left}{clerk_panel}</div>'
    actions = btn("Record time", "secondary", "sm", "timer", ["T"]) + btn("Publish notice", "primary", "sm", "court") + ibtn("more", "More", size="sm")
    return frame("matters", ["Matters", "WE-142", "Estate of Margaret Whitfield"], actions, page)


# ------------------------------------------------------------------ Matters (list, board)
MATTERS = [
    ("attention", "WE-097", "Nguyen v Nguyen", "fp", ("blocked", 0), "Evidence", ("Overdue 2d", "overdue"), ("DK", "3"), "$18,920", "urgent", True),
    ("attention", "WE-133", "Estate of Doris Fairweather", "loa", ("active", .25), "Next of kin search", ("Mon 12 Oct", "upcoming"), ("PS", "2"), "$3,105", "high", True),
    ("progress", "WE-142", "Estate of Margaret Whitfield", "probate", ("active", .25), "Notice period", ("Today", "today"), ("JP", None), "$4,860", "high", False),
    ("progress", "WE-151", "Harriet and Paul Okafor", "will", ("review", .75), "Awaiting signing", ("Thu 8 Oct", "soon"), ("JP", None), "$2,200", "medium", False),
    ("progress", "WE-118", "Estate of Robert Chen", "admin", ("active", .5), "Collecting assets", ("Wed 21 Oct", "upcoming"), ("PS", "2"), "$12,340", "medium", False),
    ("progress", "WE-171", "Doyle v Brennan", "contest", ("active", .3), "Evidence", ("Fri 9 Oct", "upcoming"), ("DK", "3"), "$9,640", "high", False),
    ("progress", "WE-156", "Alan Brooks", "poa", ("review", .75), "Draft sent", ("Fri 9 Oct", "upcoming"), ("JP", None), "$650", "low", False),
    ("progress", "WE-087", "Estate of Ivy Santoro", "trust", ("active", .5), "Annual trust return", ("13 Nov", "upcoming"), ("DK", "3"), "$1,480", "low", False),
    ("intake", "WE-160", "Estate of George Lambert", "probate", ("draft", 0), "Clerk reading 4 documents", None, ("JP", None), "$0", "none", False),
]
# Pinned to the sidebar (CORE-23): the list marks them.
PINNED = {"WE-097", "WE-142", "WE-151"}
GROUPS = [("attention", "Needs attention", ("blocked", 0)), ("progress", "In progress", ("active", .5)), ("intake", "Intake", ("draft", 0))]


def matters_toolbar():
    return ('<div class="mt-row" style="padding:10px 20px;border-bottom:1px solid var(--border-default);gap:6px">'
            + '<button class="mt-chip" data-selected>' + icon("user") + 'Mine <span class="mono-s">18</span></button><button class="mt-chip">All matters</button><button class="mt-chip" data-variant="filter">' + icon("plus") + "Filter</button>"
            + '<span class="mt-ml" style="width:380px"><span class="mt-input" data-size="sm" style="border-color:var(--border-ai);background:var(--bg-ai-subtle)">' + icon("sparkle", None, "t-ai") + '<span class="v t-ai">Filter in plain English: “probate waiting on a valuation”</span></span></span></div>')


def matters_list(overlay=""):
    body = []
    for g, label, st in GROUPS:
        rows = [m for m in MATTERS if m[0] == g]
        body.append(f'<tr class="group"><td colspan="10"><span class="mt-row">{icon("chevron-down", "sm")}{status(*st)}<span class="t-1">{label}</span><span class="mt-count">{len(rows)}</span><span class="mt-ml">{ibtn("plus", "Add", size="sm")}</span></span></td></tr>')
        for i, (_, ref, name, t, stt, stage, dl_, (who, hue), wip, pr, flag) in enumerate(rows):
            sel = ref == "WE-142"
            fl = f' <span class="mt-badge" data-tone="danger" style="margin-left:6px">Clerk flag</span>' if flag else ""
            pin = icon("pin", "sm", "t-3") if ref in PINNED else ""
            more = ibtn("more", f"More actions for {ref}", size="sm") if sel else ""
            dlh = deadline(*dl_) if dl_ else '<span class="mt-working caption"><span class="dots"><i></i><i></i><i></i></span>Building</span>'
            body.append(f'<tr{" data-selected" if sel else ""}><td style="width:36px;padding-right:0">{check("on" if sel else "off")}</td><td style="width:22px;padding:0 4px">{priority(pr)}</td><td class="ref">{ref}</td><td><span class="mt-row" style="gap:8px">{status(*stt)}<span class="title">{name}</span>{pin}{fl}</span></td><td>{tag(t)}</td><td class="t-2">{stage}</td><td>{dlh}</td><td><span class="mt-row" style="gap:6px">{avatar(who, hue=hue)}</span></td><td class="num">{wip}</td><td style="width:44px;padding:0 12px 0 4px">{more}</td></tr>')
    table = ('<table class="mt-table"><thead><tr><th></th><th></th><th>Ref</th><th>Matter</th><th>Type</th><th>Stage</th><th>Next deadline</th><th>Owner</th><th class="num">WIP</th><th><span class="mt-sr">Actions</span></th></tr></thead><tbody>' + "".join(body) + "</tbody></table>")
    bulk = ('<div style="position:absolute;left:50%;bottom:24px;transform:translateX(-50%);display:flex;align-items:center;gap:4px;padding:6px 6px 6px 14px;border-radius:10px;background:var(--bg-inverse);color:var(--text-inverse);box-shadow:var(--shadow-dialog)">'
            '<span class="label" style="margin-right:8px">1 selected</span>' + "".join(f'<button class="mt-btn" data-variant="ghost" data-size="sm" style="color:var(--text-inverse)">{icon(i)}{l}</button>' for i, l in [("user-plus", "Assign"), ("timer", "Record time"), ("archive", "Archive")]) + btn("Summarise for partner", "ai", "sm", "sparkle") + "</div>")
    page = '<div style="flex:1;position:relative;display:flex;flex-direction:column">' + matters_toolbar() + '<div style="padding:0 8px">' + table + "</div>" + bulk + "</div>"
    actions = '<div class="mt-seg"><button class="mt-seg-item" data-selected>' + icon("list") + 'List</button><button class="mt-seg-item">' + icon("board") + "Board</button><button class=\"mt-seg-item\">" + icon("calendar") + "Timeline</button></div>" + btn("Display", "ghost", "sm", "settings") + btn("New matter", "primary", "sm", "plus", ["C"])
    return frame("matters", ["Matters"], actions, page, overlay)


def matters_board():
    cols = [("Intake", ("draft", 0), [("WE-160", "Estate of George Lambert", "probate", ("draft", 0), None, [("JP", None)], "Clerk is building this matter from 4 documents.")]),
            ("Instructions & will", ("active", .25), [("WE-151", "Harriet and Paul Okafor", "will", ("review", .75), ("Thu 8 Oct", "soon"), [("JP", None)], None), ("WE-156", "Alan Brooks", "poa", ("review", .75), ("Fri 9 Oct", "upcoming"), [("JP", None)], None)]),
            ("Notice & filing", ("active", .5), [("WE-142", "Estate of Margaret Whitfield", "probate", ("active", .25), ("Today", "today"), [("JP", None), ("PS", "2")], WHITFIELD_HINT), ("WE-133", "Estate of Doris Fairweather", "loa", ("active", .25), ("Mon 12 Oct", "upcoming"), [("PS", "2")], None)]),
            ("Grant & collection", ("active", .75), [("WE-118", "Estate of Robert Chen", "admin", ("active", .5), ("Wed 21 Oct", "upcoming"), [("PS", "2")], None), ("WE-087", "Estate of Ivy Santoro", "trust", ("active", .5), ("13 Nov", "upcoming"), [("DK", "3")], None)]),
            ("Disputes", ("blocked", 0), [("WE-097", "Nguyen v Nguyen", "fp", ("blocked", 0), ("Overdue 2d", "overdue"), [("DK", "3")], "Affidavit service is 2 days late. A draft extension letter is ready."),
                                           ("WE-171", "Doyle v Brennan", "contest", ("active", .3), ("Fri 9 Oct", "upcoming"), [("DK", "3")], None)])]
    out = []
    for name, st, cards in cols:
        cs = []
        for ref, nm, t, stt, dl_, who, hint in cards:
            h = f'<div class="hint">{icon("sparkle")}<span>{hint}</span></div>' if hint else ""
            d = deadline(*dl_) if dl_ else ""
            cs.append(f'<div class="mt-matter-card"><div class="top">{status(*stt)}<span>{ref}</span><span class="mt-ml">{priority("urgent" if dl_ and dl_[1] == "overdue" else "medium")}</span></div><div class="name">{nm}</div><div class="meta">{tag(t)}{d}<span class="mt-ml mt-avatars">{"".join(avatar(a, hue=h_) for a, h_ in who)}</span></div>{h}</div>')
        out.append(f'<div class="mt-col" style="gap:8px;width:218px;flex:none"><div class="mt-row" style="height:32px;padding:0 4px">{status(*st)}<span class="label">{name}</span><span class="mt-count">{len(cards)}</span><span class="mt-ml">{ibtn("plus", "Add matter", size="sm")}</span></div>{"".join(cs)}</div>')
    page = matters_toolbar() + '<div style="display:flex;gap:12px;padding:16px 20px;background:var(--bg-canvas);flex:1;overflow:hidden">' + "".join(out) + "</div>"
    actions = '<div class="mt-seg"><button class="mt-seg-item">' + icon("list") + 'List</button><button class="mt-seg-item" data-selected>' + icon("board") + "Board</button><button class=\"mt-seg-item\">" + icon("calendar") + "Timeline</button></div>" + btn("Display", "ghost", "sm", "settings") + btn("New matter", "primary", "sm", "plus", ["C"])
    return frame("matters", ["Matters"], actions, page)


# ------------------------------------------------------------------ Deadlines
def deadlines():
    groups = [("Overdue", [("WED 30 SEP", "fp", "Serve plaintiff’s affidavit", "Nguyen v Nguyen", "Court orders 12 Sep · para 3", ("Overdue 2d", "overdue"), ("DK", "3"))]),
              ("This week", [("FRI 2 OCT", "probate", "Publish notice of intended application", "Estate of Margaret Whitfield", "A&amp;P Rules 2014", ("Today", "today"), ("JP", None)),
                             ("THU 8 OCT", "will", "Will and EPA signing (two witnesses)", "Harriet and Paul Okafor", "Wills Act 1997 (Vic) s 7", ("Thu 8 Oct", "soon"), ("JP", None)),
                             ("FRI 9 OCT", "contest", "Registrar’s directions (online)", "Doyle v Brennan", "Orders 11 Aug · TEP List", ("Fri 9 Oct", "upcoming"), ("DK", "3")),
                             ("FRI 9 OCT", "poa", "Return signed enduring power of attorney", "Alan Brooks", "Client follow-up", ("Fri 9 Oct", "upcoming"), ("JP", None))]),
              ("Next week", [("MON 12 OCT", "loa", "Complete next-of-kin search", "Estate of Doris Fairweather", "APA 1958 (Vic) Pt I Div 6", ("Mon 12 Oct", "upcoming"), ("PS", "2")),
                             ("FRI 16 OCT", "probate", "File probate application (earliest)", "Estate of Margaret Whitfield", "A&amp;P Rules 2014 · 14 days after notice", ("16 Oct", "upcoming"), ("JP", None))]),
              ("Later", [("WED 21 OCT", "admin", "Statutory notice to claimants expires", "Estate of Robert Chen", "APA 1958 (Vic) s 33", ("Wed 21 Oct", "upcoming"), ("PS", "2")),
                         ("FRI 13 NOV", "trust", "Lodge trust tax return", "Estate of Ivy Santoro", "Testamentary trust · FY 2025–26", ("13 Nov", "upcoming"), ("DK", "3")),
                         ("MON 16 NOV", "admin", "Family provision window ends", "Estate of Robert Chen · grant 14 May", "APA 1958 (Vic) s 99 · rolled from Sat 14 Nov", ("16 Nov", "upcoming"), ("PS", "2"))])]
    rows = []
    for g, items in groups:
        rows.append(f'<tr class="group"><td colspan="5"><span class="mt-row">{icon("chevron-down", "sm")}<span class="t-1">{g}</span><span class="mt-count">{len(items)}</span></span></td></tr>')
        for d, t, title, m, rule, dl_, (who, hue) in items:
            rows.append(f'<tr><td class="mono-s t-3" style="width:112px">{d}</td><td><div class="title">{title}</div><div class="caption t-3">{m}</div></td><td>{tag(t)}</td><td style="max-width:220px"><span class="mt-cite" title="{rule}">{icon("scale", "sm")}<span class="mt-ell">{rule}</span></span></td><td style="text-align:right;padding-right:20px">{deadline(*dl_)}</td></tr>')
    table = '<table class="mt-table"><thead><tr><th>Date</th><th>Deadline</th><th>Type</th><th>Rule</th><th style="text-align:right;padding-right:20px">Due</th></tr></thead><tbody>' + "".join(rows) + "</tbody></table>"
    # mini calendar: Oct 2026 starts Thursday
    days = ['<span class="caption t-3" style="text-align:center">' + d + "</span>" for d in "MTWTFSS"]
    marks = {2: "brand", 8: "warning", 9: "neutral", 12: "neutral", 16: "neutral", 21: "neutral", 30: None}
    days += ["<span></span>"] * 3
    for n in range(1, 32):
        today_ = n == 2
        dot = marks.get(n)
        dt = f'<i style="position:absolute;bottom:3px;left:50%;width:4px;height:4px;margin-left:-2px;border-radius:50%;background:var(--{"status-warning" if dot == "warning" else "icon-brand" if dot == "brand" else "status-neutral"})"></i>' if dot and not today_ else ""
        st = "background:var(--bg-brand);color:var(--text-on-brand);font-weight:600;" if today_ else ("color:var(--text-tertiary);" if n in (3, 4, 10, 11, 17, 18, 24, 25, 31) else "")
        days.append(f'<span class="mono" style="position:relative;display:grid;place-items:center;height:32px;border-radius:6px;{st}">{n}{dt}</span>')
    cal = '<div class="mt-card" data-pad>' + section_h("October 2026", ibtn("chevron-left", "Previous month", size="sm") + ibtn("chevron-right", "Next month", size="sm")) + '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px">' + "".join(days) + '</div><p class="caption t-3" style="margin:0">Court deadlines count on the Supreme Court calendar. Geelong takes Geelong Cup Day (Wed 28 Oct) instead of Melbourne Cup Day, so reminders use the firm’s calendar.</p></div>'
    rules = ('<div class="mt-card" data-pad>' + section_h("Rule sets", badge("VIC", "brand")) + '<div class="mt-col" style="gap:10px">'
             + "".join(f'<div class="mt-row" style="align-items:flex-start">{icon("scale", None, "t-3")}<div class="mt-grow"><div class="label">{a}</div><div class="caption t-3">{b}</div></div>{switch(True)}</div>' for a, b in [("Probate and administration", "A&amp;P Rules 2014 · RedCrest"), ("Family provision", "APA 1958 (Vic) Pt IV"), ("Estate distribution", "APA 1958 (Vic) ss 33, 99A"), ("Costs disclosure", "Legal Profession Uniform Law Pt 4.3")])
             + '</div><p class="caption t-3" style="margin:0">Rules are drafted by Clerk and approved by a practitioner before they generate deadlines.</p></div>')
    page = ('<div style="display:grid;grid-template-columns:minmax(0,1fr) 320px;flex:1"><div style="min-width:0;border-right:1px solid var(--border-default)"><div class="mt-row" style="padding:10px 20px;border-bottom:1px solid var(--border-default);gap:6px">'
            + '<button class="mt-chip" data-selected>Mine</button><button class="mt-chip">Team</button><button class="mt-chip" data-variant="filter">' + icon("plus") + 'Type</button><button class="mt-chip" data-variant="filter">' + icon("plus") + "Jurisdiction</button></div>"
            + '<div style="padding:0 8px">' + table + '</div></div><div class="mt-col" style="gap:12px;padding:16px;background:var(--bg-canvas)">' + cal + rules + "</div></div>")
    actions = '<div class="mt-seg"><button class="mt-seg-item" data-selected>' + icon("list") + 'List</button><button class="mt-seg-item">' + icon("calendar") + "Calendar</button></div>" + btn("Sync to Outlook", "ghost", "sm", "external") + btn("Add deadline", "primary", "sm", "plus")
    return frame("deadlines", ["Deadlines"], actions, page)


# ------------------------------------------------------------------ Billing
ON_TRACK = '<span class="caption t-3">On track</span>'


def billing():
    wip = [("WE-097", "Nguyen v Nguyen", "Capped · $22,000", 86, "$18,920", ("Update disclosure", "danger")),
           ("WE-118", "Estate of Robert Chen", "Hourly · $440", 41, "$12,340", None),
           ("WE-142", "Estate of Margaret Whitfield", "Hourly · $440", 27, "$4,860", None),
           ("WE-133", "Estate of Doris Fairweather", "Hourly · $380", 52, "$3,105", ("Unbilled 47 days", "warning")),
           ("WE-151", "Harriet and Paul Okafor", "Fixed · $2,200", 100, "$2,200", ("Bill on signing", "success")),
           ("WE-087", "Estate of Ivy Santoro", "Fixed · $1,480", 100, "$1,480", ("Ready to bill", "success"))]
    rows = "".join(f'<tr><td class="ref">{r}</td><td><div class="title">{m}</div><div class="caption t-3">{a}</div></td><td style="width:160px"><div class="mt-row">{progress(p, "danger" if p > 80 and b and b[1] == "danger" else None)}<span class="mono-s t-3" style="width:32px;text-align:right">{p}%</span></div></td><td class="num">{v}</td><td>{badge(*b) if b else ON_TRACK}</td></tr>' for r, m, a, p, v, b in wip)
    caps = "".join(time_entry(t, s, h, a, i, True) for t, s, h, a, i in [
        ("Emails with executor re: asset schedule", "3 emails · 10:42–11:05 · WE-142", "0.4 h", "$176.00", "mail"),
        ("Letter to other side re: extension", "Word · 34 min editing · WE-097", "0.6 h", "$264.00", "draft"),
        ("Conference with Ms Okafor re: attorneys", "Calendar · 25 min · WE-151", "0.5 h", "Fixed fee", "calendar"),
        ("Reviewed share registry statements", "PDF · 11 pages · WE-118", "0.3 h", "$132.00", "document"),
        ("Call with Peter Hale (executor)", "Phone · 9 min · WE-142", "0.2 h", "$88.00", "phone")])
    page = ('<div class="mt-page"><div class="mt-row"><h1 class="title-l" style="margin:0">Time and billing</h1><span class="body-s t-3" style="margin-left:8px">October 2026 · FY 2026–27 target $620,000</span></div>'
            + '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">'
            + stat("Billed this month", "$38,420", progress(74) + '<span class="mono-s">of $52k</span>')
            + stat("Work in progress", "$42,860", spark())
            + stat("Utilisation", "71", 'target 75% · <span class="mt-delta" data-dir="down">▼ 3 pts</span>', "%")
            + stat("Debtors 60+ days", "$6,940", "2 invoices · reminders drafted") + "</div>"
            + '<div style="display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:16px;align-items:start">'
            + '<div class="mt-card" data-pad>' + section_h("Work in progress", btn("Export", "ghost", "sm", "upload")) + '<div style="margin:0 -16px"><table class="mt-table"><thead><tr><th>Ref</th><th>Matter</th><th>Of estimate</th><th class="num">WIP</th><th>Status</th></tr></thead><tbody>' + rows + "</tbody></table></div>"
            + '<div class="mt-note" data-tone="warning">' + icon("alert") + '<span class="mt-grow"><b>Nguyen v Nguyen</b> has used 86% of the disclosed estimate. Under the Uniform Law, tell the client when costs will materially exceed it. Clerk has drafted an updated disclosure.</span>' + btn("Review", "secondary", "sm") + "</div>"
            + '<div class="mt-row" style="padding:8px 12px;border-radius:8px;background:var(--bg-canvas)"><span class="body-s t-2 mt-grow"><b class="t-1">3 matters</b> are ready to bill: Okafor, Santoro and Fairweather.</span>' + btn("Draft 3 invoices", "ai", "sm", "sparkle") + "</div></div>"
            + '<div class="mt-card" data-pad>' + section_h("Captured time to review", badge("5 · 2.0 h", "ai", "sparkle")) + '<p class="caption t-3" style="margin:-4px 0 0">Drafted from yesterday’s email, calendar, calls and documents, in 6-minute units.</p><div class="mt-col" style="gap:8px">' + caps + '</div><div class="mt-row">' + btn("Accept all", "ai", None, "check") + btn("Review one by one", "ghost") + "</div></div>"
            + "</div></div>")
    actions = '<div class="mt-seg"><button class="mt-seg-item">Week</button><button class="mt-seg-item" data-selected>Month</button><button class="mt-seg-item">FY</button></div>' + btn("Record time", "primary", "sm", "timer", ["T"])
    return frame("billing", ["Time and billing"], actions, page)


# ------------------------------------------------------------------ Intake
def intake():
    docs = "".join(f'<div class="mt-row" style="gap:10px;padding:6px 0"><span style="width:28px;height:28px;border-radius:6px;display:grid;place-items:center;background:var(--bg-sunken);color:var(--icon-default)">{icon("document")}</span><div class="mt-grow"><div class="label mt-ell">{n}</div><div class="caption t-3">{m}</div></div>{status("done" if s else "active", .6)}</div>'
                   for n, m, s in [("Will_Lambert_2021.pdf", "14 pages · will", True), ("Death_certificate.pdf", "1 page · Vic BDM", True), ("Rates_notice_Geelong.pdf", "2 pages · council rates", True), ("Westpac_statement_Aug.pdf", "Reading page 3 of 6", False)])
    conf = {"high": ("Confirmed", "success"), "check": ("Check", "warning"), "missing": ("Missing", "danger")}
    fields = "".join(f'<div class="mt-row" style="padding:8px 10px;border-radius:8px;{"background:var(--bg-warning-subtle);" if c == "check" else "background:var(--bg-danger-subtle);" if c == "missing" else ""}"><div class="mt-col mt-grow" style="gap:2px"><span class="caption t-3">{k}</span><span class="body{" t-3" if c == "missing" else ""}">{v}</span></div>{cite(src) if src else ""}{badge(*conf[c])}</div>'
                     for k, v, src, c in [("Deceased", "George William Lambert", "Death certificate", "high"), ("Date of death", "19 Sep 2026", "Death certificate", "high"), ("Last address", "22 Kite St, Ocean Grove VIC 3226", "Rates notice", "high"),
                                          ("Will", "12 Feb 2021 · 14 pages", "Will p 14", "high"), ("Executor", "Susan Margaret Lambert (spouse)", "Will cl. 2", "high"), ("Alternate executor", "Mark Lambert (son)", "Will cl. 2(b)", "check"), ("Executor’s address", "Not found in the documents", None, "missing")])
    page = ('<div class="mt-page"><div class="mt-row" style="align-items:flex-end"><div class="mt-col" style="gap:6px"><span class="eyebrow t-3">New matter · from documents</span><h1 class="title-l" style="margin:0">Estate of George Lambert</h1><span class="body-s t-2">Clerk is building the matter from the documents you dropped in. Confirm anything marked Check or Missing.</span></div></div>'
            + '<div style="display:grid;grid-template-columns:300px minmax(0,1fr) 360px;gap:16px;align-items:start">'
            + '<div class="mt-card" data-pad>' + section_h("Documents", '<span class="mono-s t-3">4 files</span>') + '<div class="mt-col" style="gap:0">' + docs + '</div><div class="mt-row" style="gap:10px;padding:14px;border:1px dashed var(--border-strong);border-radius:8px;color:var(--icon-default)">' + icon("upload") + '<div><div class="label t-1">Drop more documents</div><div class="caption t-3">Wills, certificates, statements, title searches</div></div></div>'
            + progress(64, "ai") + '<span class="mt-working caption"><span class="dots"><i></i><i></i><i></i></span><span class="mt-shimmer">Building the asset schedule</span></span></div>'
            + '<div class="mt-card" data-pad>' + section_h("Extracted details", badge("Clerk draft", "ai", "sparkle")) + '<div class="mt-row" style="gap:8px"><span class="caption t-3">Matter type</span>' + tag("probate") + '<span class="caption t-3">Supreme Court of Victoria · will found, executor named</span></div><div class="mt-col" style="gap:2px">' + fields + "</div></div>"
            + '<div class="mt-col" style="gap:16px"><div class="mt-card" data-pad>' + section_h("Deadlines Clerk will track") + '<div class="mt-timeline">'
            + tl("next", "Publish notice of intended application", "<code>A&amp;P Rules 2014</code> · 14 days before filing", deadline("When ready", "upcoming"))
            + tl("upcoming", "Apply for probate", "Practice reminder · 6 months after death", deadline("19 Mar 2027", "upcoming"))
            + tl("upcoming", "Family provision window ends", "<code>APA 1958 (Vic) s 99</code> · 6 months from the grant", badge("After grant"), "scale") + "</div></div>"
            + '<div class="mt-card" data-pad>' + section_h("Worth a look", icon("alert", None, "t-warning")) + '<div class="mt-col" style="gap:10px">'
            + '<div class="mt-note" data-tone="warning">' + icon("draft") + '<span><b>Handwritten change on page 3</b> (clause 5, a $10,000 gift). An unattested alteration may need an affidavit of plight and condition.</span></div>'
            + '<div class="mt-note">' + icon("info") + "<span><b>Joint Westpac account</b> with Susan Lambert likely passes by survivorship, outside the estate.</span></div></div></div></div>"
            + "</div></div>")
    actions = btn("Discard", "ghost", "sm") + btn("Save draft", "secondary", "sm") + btn("Create matter", "primary", "sm", "check")
    return frame("matters", ["Matters", "New matter"], actions, page)


# ------------------------------------------------------------------ Command palette over the list
def command():
    from components import cmdk
    ov = f'<div class="mt-overlay" style="position:absolute;inset:0;display:flex;justify-content:center;align-items:flex-start;padding-top:120px;z-index:5">{cmdk}</div>'
    return matters_list(ov)


SCREENS = [
    ("Today", "Today: Clerk’s morning brief, this week’s statutory deadlines, tasks, numbers and captured time.", today),
    ("Matter", "A matter end to end: stage, key facts, estate, statutory deadlines and parties, with Clerk alongside.", matter),
    ("Matters list", "Every matter grouped by state: ref, priority, stage glyph, type, next deadline, owner and WIP, with bulk actions.", matters_list),
    ("Matters board", "The same matters as a board by phase, with Clerk hints on the cards that need a decision.", matters_board),
    ("Deadlines", "Statutory and procedural deadlines across the practice, each citing its rule, with the month view and active rule sets.", deadlines),
    ("Time and billing", "WIP against costs estimates, Uniform Law disclosure prompts, invoices to draft, and time Clerk captured for review.", billing),
    ("New matter intake", "Clerk builds a matter from a will and death certificate, with confidence, sources, deadlines and issues to check.", intake),
    ("Command palette", "⌘K over the matters list: jump to a matter or person, run an action, or hand the query to Clerk.", command),
]
