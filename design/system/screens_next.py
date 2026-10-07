"""Second-pass screens: Insights, Contacts, Settings, Onboarding, Mobile."""
from pathlib import Path

import charts
from components_next import billed_chart, grant_chart
from icons import icon, status, priority
from markup import *
from screens import frame, section_h, sidebar

LOGOS = Path(__file__).resolve().parents[1] / "assets" / "logos"  # copied from legacy src/assets/logos


def chip(label, ic=None, selected=False, filt=False):
    a = " data-selected" if selected else ""
    v = ' data-variant="filter"' if filt else ""
    return f'<button class="mt-chip"{a}{v}>{icon(ic) if ic else ""}{label}</button>'


def card(title, body, right="", span=None, extra=""):
    s = f' style="grid-column:span {span}{extra}"' if span else ""
    return f'<div class="mt-card" data-pad{s}>{section_h(title, right)}{body}</div>'


# ------------------------------------------------------------------ Insights
def insights():
    filters = ('<div class="mt-row" style="gap:6px">' + chip("FY 2026–27 to date", "calendar", True) + chip("Whole practice", "contacts") + chip("Wills and Estates", "matters") + chip("Add filter", "plus", filt=True)
               + '<span class="mt-ml">' + btn("Explain these numbers", "ai", "sm", "sparkle") + "</span></div>")
    hero = ('<div class="mt-card" data-pad style="grid-column:span 5;justify-content:space-between"><div class="mt-card-h"><h3>Billed this financial year</h3><span class="mt-ml caption t-3">1 Jul – 2 Oct</span></div>'
            '<div class="mt-hero">$186,420</div><div class="mt-col" style="gap:8px"><div class="mt-meter"><i style="width:30%"></i><b style="left:25.2%"></b></div>'
            '<div class="mt-row caption t-3"><span>30% of the $620,000 target</span><span class="mt-ml">Tick: where the year should be today (25%)</span></div>'
            '<div class="body-s t-2">On pace for <b class="t-1">$598k</b>, $22k short. June’s grants carried the last quarter.</div></div></div>')
    stats = ('<div style="grid-column:span 7;display:grid;grid-template-columns:repeat(3,1fr);gap:16px">'
             + stat("Work in progress", "$42,860", '<span class="mt-delta" data-dir="up">+$6,120</span> vs last week')
             + stat("Utilisation", "71%", 'Practice average · target 75%')
             + stat("Median days to grant", "41", '<span class="mt-delta" data-dir="up">−11</span> vs last year') + "</div>")
    billed = card("Billed by month", billed_chart(740), '<span class="caption t-3">Last 12 months</span>', 8)
    ageing = card("Work in progress by age", charts.hbars([("0–30 days", 21480, "Unbilled for up to 30 days"), ("31–60 days", 9870, "Unbilled 31 to 60 days"), ("61–90 days", 6240, "Unbilled 61 to 90 days"), ('90+ days ' + badge("Chase", "warning"), 5270, "Unbilled over 90 days: Fairweather, Santoro")], 21480, lambda v: f"${v:,.0f}")
                  + '<div class="mt-note" data-tone="warning">' + icon("alert") + '<span><b>$11,510</b> has been unbilled for more than 60 days, across 3 matters.</span></div>'
                  + charts.table_view(["Age", "WIP"], [("0–30 days", "$21,480"), ("31–60 days", "$9,870"), ("61–90 days", "$6,240"), ("90+ days", "$5,270")]), '<span class="mono">$42,860</span>', 4)
    grant = card("Median days from death to grant", '<div class="caption t-3" style="margin-top:-6px">Probate and letters of administration, by month of grant</div>' + grant_chart(540), "", 6)
    mix_rows = [(tag("will", "Wills and EPAs"), 14), (tag("probate"), 9), (tag("admin"), 7), (tag("poa"), 5), (tag("loa"), 3), (tag("fp"), 3), (tag("trust"), 1)]
    mix = card("Active matters by type", charts.hbars([(l, v, "Active matters") for l, v in mix_rows], 14) + charts.table_view(["Type", "Active matters"], [("Wills and EPAs", 14), ("Probate", 9), ("Estate admin", 7), ("Power of attorney", 5), ("Letters of admin", 3), ("Family provision", 3), ("Testamentary trust", 1)]), '<span class="mono">42</span>', 6)
    util = card("Utilisation by fee earner", '<div class="mt-col" style="gap:14px">' + "".join(
        f'<div class="mt-row" style="gap:10px">{avatar(a, hue=h)}<span class="label" style="width:96px">{n}</span><div class="mt-meter mt-grow"{" data-tone=warning" if v < 65 else ""} tabindex="0" data-tip="{v}%|{n} · target 75%"><i style="width:{v}%"></i><b style="left:75%"></b></div><span class="mono" style="width:36px;text-align:right">{v}%</span></div>'
        for a, n, h, v in [("MT", "Mia Torres", "4", 82), ("PS", "Priya Shah", "2", 78), ("JP", "Jordan Price", None, 71), ("DK", "Daniel Kim", "3", 62)]) + '<span class="caption t-3">Tick marks the 75% target. Daniel’s hours include 14 h of unbillable mentoring.</span></div>', "", 4)
    refs = [("Hale Accounting", "Peter Hale", 9, "$38,200"), ("Existing clients", "Will reviews and family", 11, "$44,100"), ("Geelong Financial Planning", "Sarah Lin", 6, "$21,400"), ("Uniting Church Newtown", "Bequest program", 4, "$9,800"), ("Website enquiries", "Form and phone", 5, "$8,300")]
    ref_rows = "".join(f'<tr><td><div class="title">{n}</div><div class="caption t-3">{c}</div></td><td class="num">{m}</td><td class="num">{v}</td></tr>' for n, c, m, v in refs)
    referrers = card("Where new matters come from", f'<div style="margin:0 -16px"><table class="mt-table"><thead><tr><th>Referrer</th><th class="num">Matters</th><th class="num">Billed FY</th></tr></thead><tbody>{ref_rows}</tbody></table></div>', btn("Contacts", "ghost", "sm", trail="arrow-right"), 5)
    clerk = ('<div class="mt-clerk-card" style="grid-column:span 3"><div class="in"><div class="mt-clerk-head">' + clerk_av() + 'Clerk this year</div>'
             + "".join(f'<div class="mt-col" style="gap:0"><span class="numeric-m">{v}</span><span class="caption t-3">{k}</span></div>' for v, k in [("38.2 h", "captured time accepted ($16,808)"), ("91%", "of suggestions accepted (214 of 235)"), ("12", "deadlines found that weren’t diarised"), ("27", "drafts used after review")])
             + '</div></div>')
    page = ('<div class="mt-page">' + filters + '<div style="display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px;align-items:start">'
            + hero + stats + billed + ageing + grant + mix + util + referrers + clerk + "</div></div>")
    return frame("insights", ["Insights"], btn("Export", "ghost", "sm", "upload") + btn("Share with partners", "secondary", "sm", "user-plus"), page)


def clerk_av():
    return avatar(kind="clerk", size="sm")


# ------------------------------------------------------------------ Contacts
PEOPLE = [("CW", None, "Catherine Whitfield", "Executor · beneficiary · client", "3"), ("PH", "2", "Peter Hale", "Executor · referrer · Hale Accounting", "12"),
          ("TW", "risk", "Thomas Whitfield", "Son of the deceased · WE-142", "1"), ("SL", "4", "Susan Lambert", "Executor · WE-160", "1"),
          ("HO", "3", "Harriet Okafor", "Client · wills and EPA", "1"), ("KH", "2", "Kevin Ho", "Opposing solicitor · Ho Legal", "1"),
          ("AB", None, "Alan Brooks", "Client · power of attorney", "1"), ("SL", "3", "Sarah Lin", "Referrer · Geelong Financial Planning", "6"),
          ("DF", "4", "Doris Fairweather (dec.)", "Deceased · intestate · WE-133", "1")]


def contacts():
    rows = "".join(f'<div class="mt-row" style="gap:10px;padding:8px 12px;border-radius:6px;{"background:var(--bg-selected);" if i == 0 else ""}">{avatar(a, hue=h)}<div class="mt-grow"><div class="label mt-ell">{n}</div><div class="caption t-3 mt-ell">{r}</div></div><span class="mono-s t-3">{m}</span></div>' for i, (a, h, n, r, m) in enumerate(PEOPLE))
    left = ('<div style="width:380px;flex:none;border-right:1px solid var(--border-default);display:flex;flex-direction:column">'
            '<div class="mt-col" style="padding:12px;gap:10px;border-bottom:1px solid var(--border-default)"><span class="mt-input" data-size="sm">' + icon("search") + '<span class="v ph">Search 318 contacts</span></span>'
            '<div class="mt-row mt-wrap" style="gap:6px">' + chip("All", selected=True) + chip("Clients") + chip("Executors") + chip("Beneficiaries") + chip("Referrers") + "</div></div>"
            '<div class="mt-col" style="gap:1px;padding:8px">' + rows + "</div></div>")
    matters = "".join(f'<div class="mt-row" style="gap:10px;padding:8px 0;border-top:1px solid var(--border-subtle)">{status(*st)}<span class="mono-s t-3" style="width:52px">{ref}</span><div class="mt-grow"><div class="label">{n}</div><div class="caption t-3">{r}</div></div>{chip_}</div>' for st, ref, n, r, chip_ in [
        (("active", .25), "WE-142", "Estate of Margaret Whitfield", "Executor · beneficiary 50%", deadline("Today", "today")),
        (("done", 1), "WE-031", "Catherine Whitfield: will and EPA", "Client · signed 14 Mar 2021 · original in safe custody", badge("Review due", "warning")),
        (("done", 1), "WE-019", "Estate of Leonard Whitfield", "Beneficiary · finalised 2019", badge("Closed"))])
    family = ('<div class="mt-col" style="gap:0">' + "".join(f'<div class="mt-row" style="gap:10px;padding:6px 0">{avatar(a, "sm", hue=h)}<span class="label mt-grow">{n}</span><span class="caption t-3">{r}</span></div>' for a, h, n, r in [
        ("MW", None, "Margaret Whitfield (dec.)", "Mother · died 22 Jul 2026"), ("LW", None, "Leonard Whitfield (dec.)", "Father · died 2018"), ("TW", "risk", "Thomas Whitfield", "Brother"), ("EW", "4", "Ella Whitfield", "Daughter · 19"), ("JW", "4", "Jack Whitfield", "Son · 16")]) + "</div>")
    activity = ('<div class="mt-timeline">' + tl("done", "Call: will drop original will and statements on Friday", "Jordan Price · 29 Sep · 12 min · 0.2 h recorded", "", "phone")
                + tl("done", "Email: CBA statements (3 attachments)", "Filed to WE-142 · 30 Sep", "", "mail") + tl("upcoming", "Signing appointment for her own will review", "Not booked yet", "", "calendar") + "</div>")
    detail = ('<div class="mt-page" style="flex:1;min-width:0">'
              + '<div class="mt-col" style="gap:12px"><div class="mt-person">' + avatar("CW", "xl") + '<div class="mt-col" style="gap:2px"><span class="nm">Catherine Whitfield</span><span class="body-s t-3">Belmont VIC · client since 2019</span></div><span class="mt-ml mt-row" style="gap:6px">' + badge("ID verified 4 Aug", "success") + badge("Conflict check clear", "success") + ibtn("more", "More", size="sm") + "</span></div>"
              + '<div class="mt-roles"><span class="mt-role">Executor<span class="ref">WE-142</span></span><span class="mt-role">Beneficiary 50%<span class="ref">WE-142</span></span><span class="mt-role">Will client<span class="ref">WE-031</span></span><span class="mt-role">Beneficiary<span class="ref">WE-019</span></span></div></div>'
              + '<div class="mt-suggestion">' + clerk_av() + '<div class="mt-grow"><div class="tt">Catherine’s own will names her mother as substitute executor. Margaret has died, so the will needs review.</div><div class="ts">From will WE-031 cl. 3 and the death certificate on WE-142</div></div>' + btn("Dismiss", "ghost", "sm") + btn("Create review task", "ai", "sm") + "</div>"
              + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">'
              + card("Contact", '<dl class="mt-facts"><dt>Mobile</dt><dd class="mono">0412 555 018</dd><dt>Email</dt><dd>cwhitfield@example.com.au</dd><dt>Address</dt><dd>9 Raglan St, Belmont VIC 3216</dd><dt>Born</dt><dd>14 Jun 1968</dd><dt>Prefers</dt><dd>Phone, after 3 pm</dd></dl>', btn("Edit", "ghost", "sm"))
              + card("Family", family, btn("Tree", "ghost", "sm", "family-tree"))
              + card("Matters", matters, '<span class="mono-s t-3">3</span>')
              + card("Recent activity", activity, btn("Log call", "ghost", "sm", "phone"))
              + "</div></div>")
    page = f'<div style="display:flex;flex:1;min-height:0">{left}{detail}</div>'
    return frame("contacts", ["Contacts", "Catherine Whitfield"], btn("Email", "secondary", "sm", "mail") + btn("New contact", "primary", "sm", "plus"), page)


# ------------------------------------------------------------------ Settings
def settings_sidebar(active="Clerk and AI"):
    # Sidebar order follows the app's SETTINGS_SECTIONS (CORE-21); Account, Trust, Rule sets, Integrations and Security are designed ahead (DES-01); Claude connector is INT-07.
    groups = [("Account", [("Profile", "user"), ("Preferences", "settings"), ("Notifications", "bell")]),
              ("Firm", [("Practice", "matters"), ("Team and roles", "contacts"), ("Billing and rates", "billing"), ("Trust account", "lock")]),
              ("Practice", [("Matter numbering", "list"), ("Matter templates", "board"), ("Rule sets", "scale")]),
              ("Clerk", [("Clerk and AI", "sparkle")]),
              ("Connections", [("Integrations", "link"), ("Claude connector", "share"), ("Security", "shield")]),
              ("Records", [("Audit log", "eye")])]
    h = ['<aside class="mt-sidebar">', '<a class="mt-nav" href="#" onclick="return false" style="margin-bottom:6px">' + icon("chevron-left") + '<span>Back to materia</span></a>']
    for g, items in groups:
        h.append(f'<div class="mt-nav-section">{g}</div>')
        h += [nav(l, i, active=(l == active)) for l, i in items]
    h.append("</aside>")
    return "".join(h)


def setting(title, sub, control, locked=False):
    lk = " data-locked" if locked else ""
    t = f'{title} {icon("shield")}' if locked else title
    return f'<div class="mt-setting"{lk}><div class="tx"><div class="tt">{t}</div><div class="ts">{sub}</div></div>{control}</div>'


def select_sm(v):
    return f'<span class="mt-input mt-select" data-size="sm" style="width:220px"><span class="v">{v}</span>{icon("updown")}</span>'


def settings():
    sec = lambda h, p, rows: f'<div class="mt-settings-section"><h3>{h}</h3><p>{p}</p>{"".join(rows)}</div>'
    body = ('<div class="mt-col" style="gap:28px;max-width:720px">'
            + '<div class="mt-col" style="gap:6px"><h1 class="title-l" style="margin:0">Clerk and AI</h1><p class="body t-2" style="margin:0">Choose what Clerk can read and do for Hale &amp; Price. These settings apply to everyone; people can turn individual features off for themselves under Preferences.</p></div>'
            + sec("What Clerk can read", "Clerk only reads what is on here, and only within matters the person asking can open.", [
                setting("Matter documents", "Wills, certificates, statements, correspondence and file notes filed to a matter.", switch(True)),
                setting("Email", "Emails filed to a matter or exchanged with a matter’s contacts. Personal mail is never read.", switch(True)),
                setting("Calendar", "Appointments and court dates, to suggest deadlines and capture time.", switch(True)),
                setting("Phone call logs", "Call times and durations from your phone system, for time capture.", switch(False)),
                setting("Trust account ledger", "Needs the trust account integration.", switch(False, disabled=True))])
            + sec("What Clerk can do", "Everything Clerk produces arrives as a suggestion or a draft.", [
                setting("Morning brief", "A summary of what needs you, on Today at 7:30 am.", switch(True)),
                setting("Suggest tasks and deadlines", "From new documents, emails and the rule sets.", switch(True)),
                setting("Capture time", "Draft time entries from email, calendar, calls and documents.", select_sm("Draft entries for review")),
                setting("Draft documents", "Draft letters, affidavits and court documents for a person to review.", switch(True)),
                setting("Send, file or bill", "Clerk never sends email, files with a registry or issues a bill. A person always does.", switch(False, disabled=True), locked=True)])
            + sec("Data and retention", "Where Clerk’s work happens and how long it is kept.", [
                setting("Processing location", "Clerk runs in Australian data centres (Sydney).", '<span class="body-s t-2">Australia</span>', locked=True),
                setting("Model training", "Your documents and conversations are never used to train AI models.", '<span class="body-s t-2">Never</span>', locked=True),
                setting("Keep Clerk conversations", "Kept with the matter file and destroyed with it.", select_sm("7 years after matter closes"))])
            + "</div>")
    aside = ('<div class="mt-col" style="gap:12px;width:300px;flex:none">'
             + '<div class="mt-card" data-pad>' + section_h("This month", btn("Activity log", "ghost", "sm", trail="arrow-right")) + '<div class="mt-col" style="gap:10px">'
             + "".join(f'<div class="mt-row"><span class="body-s t-2 mt-grow">{k}</span><span class="mono">{v}</span></div>' for k, v in [("Questions answered", "412"), ("Suggestions made", "235"), ("Accepted", "91%"), ("Drafts reviewed", "27"), ("Time entries accepted", "38.2 h")])
             + "</div></div>"
             + '<div class="mt-note">' + icon("info") + '<span>Practitioners remain responsible for advice. Clerk’s answers carry citations so they can be checked.</span></div></div>')
    page = f'<div class="mt-page"><div class="mt-row" style="align-items:flex-start;gap:40px">{body}{aside}</div></div>'
    return frame("settings", ["Settings", "Clerk and AI"], "", page, side=settings_sidebar())


# ------------------------------------------------------------------ Onboarding
def logo_mark(size=28):
    svg = (LOGOS / "square-black-logo.svg").read_text()
    return svg.replace('width="75" height="75"', f'width="{size}" height="{size}" aria-label="materia"', 1)


def onboarding():
    steps = [("done", "Your firm", "Hale & Price Lawyers · ABN added"), ("done", "Email and calendar", "Outlook connected"), ("current", "Bring in your matters", "From materia, a spreadsheet or another system"),
             ("", "Practice settings", "Jurisdictions, rates and rule sets"), ("", "Invite your team", "Roles and supervision"), ("", "Meet Clerk", "Choose what it can read and do")]
    stepl = '<ol class="mt-steps">' + "".join(f'<li data-state="{s}"><span class="n">{icon("check") if s == "done" else i + 1}</span><span>{t}<span class="sub">{d.replace("&", "&amp;")}</span></span></li>' for i, (s, t, d) in enumerate(steps)) + "</ol>"
    left = ('<aside style="width:380px;flex:none;padding:32px 40px;display:flex;flex-direction:column;gap:40px;background:var(--bg-canvas);border-right:1px solid var(--border-default)">'
            f'<div class="mt-row" style="gap:10px">{logo_mark()}<span style="font:600 17px/1 var(--font-sans);letter-spacing:-.02em">materia</span></div>'
            f'<div class="mt-col" style="gap:6px"><span class="eyebrow t-3">Setting up Hale &amp; Price</span><span class="title-m">About 10 minutes</span></div>{stepl}'
            '<div class="mt-col" style="margin-top:auto;gap:6px"><span class="label">Need a hand?</span><span class="body-s t-3">We’ll move your data with you on a 20-minute call.</span>' + btn("Book a setup call", "secondary", "sm", "calendar").replace('class="mt-btn"', 'class="mt-btn" style="align-self:flex-start"') + "</div></aside>")
    cards = "".join(f'<div class="mt-choice-card" role="radio" aria-checked="{"true" if sel else "false"}"{" data-selected" if sel else ""}><span class="glyph">{icon(ic)}</span><div class="mt-grow"><div class="tt">{t}</div><div class="ts">{d}</div></div>{x}</div>' for ic, t, d, sel, x in [
        ("inbox", "materia (current version)", "We found 42 active matters, 318 contacts, 1,208 safe-custody wills and 26 checklist templates in your workspace.", True, badge("Recommended", "brand")),
        ("upload", "Spreadsheet", "CSV or Excel. Clerk reads your columns and suggests how they map.", False, ""),
        ("document", "Another practice management system", "Upload its export file. Clerk maps matters, contacts and time.", False, "")])
    maps = [("Wills &amp; Estates › New instructions", "will", "Will · Instructions", 6, "ok"), ("Wills &amp; Estates › Drafting", "will", "Will · Drafting", 5, "ok"),
            ("Probate › Waiting on grant", "probate", "Probate · Filed", 4, "ok"), ("Probate › Collecting assets", "admin", "Estate admin · Collect", 7, "ok"),
            ("Disputes", "fp", "Family provision · from card titles", 3, "check"), ("Misc", None, "Needs a matter type", 2, "you")]
    mrows = "".join(f'<tr><td class="t-2">{a}</td><td>{icon("arrow-right", "sm", "t-3")}</td><td>{tag(t, b) if t else "<span class=t-danger>" + b + "</span>"}</td><td class="num">{n}</td><td>{badge("Mapped", "success") if s == "ok" else badge("Check", "warning") if s == "check" else badge("Needs you", "danger")}</td></tr>' for a, t, b, n, s in maps)
    content = ('<main style="flex:1;min-width:0;display:flex;flex-direction:column;background:var(--bg-surface)"><div style="flex:1;padding:56px 72px 24px;display:flex;flex-direction:column;gap:24px;max-width:860px">'
               '<div class="mt-col" style="gap:8px"><span class="eyebrow t-3">Step 3 of 6</span><h1 class="title-l" style="margin:0">Bring in your matters</h1><p class="body t-2" style="margin:0;max-width:600px">Start with the matters you’re working on now. Closed matters and safe-custody wills come across too, so nothing is left in the old system.</p></div>'
               f'<div role="radiogroup" class="mt-col" style="gap:8px">{cards}</div>'
               '<div class="mt-clerk-card"><div class="in"><div class="mt-clerk-head">' + avatar(kind="clerk", size="sm") + 'How Clerk will map your boards<span class="mt-ml caption t-3">27 of 27 cards read</span></div>'
               f'<div style="margin:0 -16px"><table class="mt-table"><thead><tr><th>Board › swimlane</th><th></th><th>Becomes</th><th class="num">Matters</th><th></th></tr></thead><tbody>{mrows}</tbody></table></div>'
               '<div class="mt-clerk-foot">Checklists become task templates, billables become time entries, and referrers become contacts. You can change any mapping after import.</div></div></div>'
               "</div>"
               '<div class="mt-row" style="padding:16px 72px;border-top:1px solid var(--border-default);gap:8px">' + btn("Back", "ghost", None, "chevron-left") + '<span class="mt-ml mt-row" style="gap:8px">' + btn("Skip for now", "ghost") + btn("Import 42 matters", "primary", trail="arrow-right") + "</span></div></main>")
    return f'<div class="mt mt-onboard" style="width:1440px;min-height:900px;display:flex;background:var(--bg-surface)">{left}{content}</div>'


# ------------------------------------------------------------------ Mobile
def statusbar():
    return ('<div class="mt-statusbar"><span>9:41</span><span class="ind"><i style="width:17px;height:10px"></i><i style="width:15px;height:10px;opacity:.9"></i>'
            '<i style="width:25px;height:12px;border-radius:3px"></i></span></div>')


def tabbar(active):
    items = [("today", "Today", "today"), ("matters", "Matters", "matters"), ("record", "Record", "mic"), ("inbox", "Inbox", "inbox"), ("more", "More", "more")]
    out = []
    for k, l, i in items:
        act = " data-active" if k == active else ""
        if k == "record":
            out.append(f'<a aria-label="Record"{act}><span class="fab">{icon(i)}</span></a>')
        else:
            out.append(f'<a{act}>{icon(i)}{l}</a>')
    return f'<nav class="mt-tabbar">{"".join(out)}</nav>'


def mtop(title, left=None, right=None, mono=False):
    """The phone top bar: back or your avatar (More), the screen's title, and one action."""
    t = f'<span class="tl"><span class="mono-s t-3">{title}</span></span>' if mono else f'<span class="tl">{title}</span>'
    return '<div class="mt-mtop">' + (left or avatar("JP")) + t + (right or '<span style="width:32px"></span>') + "</div>"


def phone_today():
    brief_items = "".join(f'<div class="mt-row" style="gap:10px;padding:10px 0;border-top:1px solid var(--border-subtle);align-items:flex-start">{icon(ic, None, "t-" + tn)}<div class="mt-grow body-s t-2"><b class="t-1">{m}</b> {t}</div>{icon("chevron-right", None, "t-3")}</div>' for ic, tn, m, t in [
        ("alert", "danger", "Nguyen.", "Affidavit service is 2 days late. Extension letter drafted."), ("court", "brand", "Whitfield.", "Publish the probate notice today."), ("draft", "warning", "Okafor.", "Thursday’s signing needs a second witness.")])
    dls = "".join(f'<div class="mt-mrow"><span class="mono-s t-3" style="width:44px">{d}</span><div class="mt-grow"><div class="tt mt-ell">{t}</div><div class="ts mt-ell">{m}</div></div>{c}</div>' for d, t, m, c in [
        ("WED", "Serve plaintiff’s affidavit", "Nguyen v Nguyen", deadline("2d", "overdue")), ("TODAY", "Publish probate notice", "Whitfield · A&amp;P Rules 2014", deadline("Today", "today")), ("THU", "Will and EPA signing", "Okafor · 10:00 am", deadline("Thu", "soon"))])
    body = ('<div class="mt-mbody"><div class="mt-col" style="gap:2px"><span class="eyebrow t-3">Friday 2 October</span><span class="title-l">Good morning, Jordan</span></div>'
            '<div class="mt-clerk-card"><div class="in" style="gap:4px"><div class="mt-clerk-head" style="padding-bottom:6px">' + avatar(kind="clerk", size="sm") + 'Morning brief</div>' + brief_items + "</div></div>"
            '<div class="mt-col" style="gap:0"><div class="mt-row"><span class="heading">This week</span><span class="mt-ml caption t-brand">All deadlines</span></div>' + dls + "</div>"
            + time_entry("6 entries from yesterday", "Clerk drafted · 2.1 h to review", "2.1 h", "$924.00", "sparkle", True, False) + "</div>")
    top = '<div class="mt-mtop">' + avatar("JP") + '<span class="tl">Today</span>' + ibtn("search", "Search") + "</div>"
    return f'<div class="mt-phone">{statusbar()}{top}{body}{tabbar("today")}</div>'


def sec(title, n, body="", open_=False):
    """A collapsible section of the phone matter screen, with its count and a See all link."""
    head = f'<div class="mt-row" style="min-height:44px"><span class="heading">{title}</span><span class="caption t-3">{n}</span><span class="mt-ml t-3">{icon("chevron-down" if open_ else "chevron-right")}</span></div>'
    return f'<div class="mt-col" style="gap:0;border-top:1px solid var(--border-subtle)">{head}{body if open_ else ""}</div>'


def phone_matter(sheet=False):
    top = mtop("WE-142", ibtn("chevron-left", "Back"), ibtn("more", "Matter actions"), mono=True)
    actions = "".join(f'<button class="mt-btn" data-variant="secondary" style="flex-direction:column;height:64px;flex:1;gap:4px;font-size:12px">{icon(i)}{l}</button>' for i, l in [("phone", "Call executor"), ("timer", "Log time"), ("compose", "Add note")])
    dls = "".join(f'<div class="mt-mrow"><div class="mt-grow"><div class="tt mt-ell">{t}</div><div class="ts mt-ell">{r}</div></div>{c}</div>' for t, r, c in [
        ("Publish notice of intended application", "A&amp;P Rules 2014", deadline("Today", "today")), ("File probate application", "From 16 Oct", deadline("16 Oct", "upcoming"))])
    # The matter brief (AI-06c) under the quick actions, as at the top of the Overview; no "Ask a follow-up" (no Clerk panel on a phone).
    brief_items = "".join(f'<div class="mt-row" style="gap:10px;padding:10px 0;border-top:1px solid var(--border-subtle);align-items:flex-start">{icon(ic, None, "t-" + tn)}<div class="mt-grow body-s t-2"><b class="t-1">{m}</b> {t}</div></div>' for ic, tn, m, t in [
        ("calendar", "warning", "Due soon.", "Publish the notice of intended application today."), ("arrow-right", "brand", "Next step.", "File the probate application from 16 Oct.")])
    brief = ('<div class="mt-clerk-card" style="flex:none"><div class="in" style="gap:4px"><div class="mt-clerk-head" style="padding-bottom:6px">' + avatar(kind="clerk", size="sm") + 'Clerk brief<span class="mt-ml">' + btn("Refresh", "ghost", "sm", "refresh") + "</span></div>"
             + '<span class="tt" style="font:600 15px/20px var(--font-sans)">The notice goes out today; the application can go in from 16 Oct.</span>' + brief_items + "</div></div>")
    body = ('<div class="mt-mbody" style="gap:12px"><div class="mt-col" style="gap:8px"><div class="mt-row" style="gap:6px">' + tag("probate") + badge("Notice period", "brand") + '</div><span class="title-l" style="font-size:22px;line-height:28px">Estate of Margaret Whitfield</span>'
            '<div class="mt-row" style="gap:10px"><div class="mt-progress mt-grow" data-size="md"><div class="mt-progress-bar" style="width:28%"></div></div><span class="caption t-3">Stage 3 of 9 · Notice</span></div></div>'
            f'<div class="mt-row" style="gap:8px">{actions}</div>'
            + brief
            + sec("Key facts", "", '<div class="mt-row body-s" style="gap:16px;padding-bottom:8px"><span class="t-3">Date of death</span><span class="mt-ml">14 Jul 2026</span></div>', True)
            + sec("Deadlines", "2", dls, True)
            + sec("Tasks", "3") + sec("Documents", "12") + sec("Notes", "4")
            + "</div>")
    ov = ""
    if sheet:
        rows = "".join(f'<div class="mt-mrow">{icon(i)}<div class="mt-grow"><div class="tt mt-ell">{t}</div>{f"<div class=ts>{d}</div>" if d else ""}</div></div>' for i, t, d in [
            ("compose", "Add note", ""), ("timer", "Log time", "")])
        people = "".join(f'<div class="mt-mrow">{icon(i)}<div class="mt-grow"><div class="tt mt-ell">{t}</div><div class="ts mt-ell">{d}</div></div></div>' for i, t, d in [
            ("phone", "Call Catherine Whitfield", "Executor · 0412 345 678"), ("mail", "Email Catherine Whitfield", "Executor · catherine@example.com"), ("phone", "Call Peter Hale", "Executor · 0398 765 432")])
        ov = ('<div class="mt-overlay" style="position:absolute;inset:0"></div><div class="mt-sheet"><span class="grab"></span>'
              '<span class="title-m mono">WE-142</span><div class="mt-col" style="gap:0">' + rows + '<span class="mt-mgroup">Contact</span>' + people + "</div></div>")
    return f'<div class="mt-phone">{statusbar()}{top}{body}{tabbar("matters")}{ov}</div>'


def phone_matters():
    top = mtop("Matters", right=ibtn("plus", "New matter"))
    search = field(None, placeholder="Number, title or client", ic="search")

    def row(t, num, ty, right=None, tag_=None):
        return (f'<div class="mt-mrow"><span style="flex:none;width:10px;height:10px;border-radius:3px;background:var(--matter-{ty})"></span>'
                f'<div class="mt-grow"><div class="tt mt-ell">{t}</div><div class="ts mono-s">{num}</div></div>{right or icon("chevron-right", None, "t-3")}</div>')
    recent = row("Estate of Margaret Whitfield", "WE-142", "probate") + row("Okafor wills and EPAs", "WE-151", "will")
    view = "".join(row(t, n, ty, r) for t, n, ty, r in [
        ("Nguyen v Nguyen", "WE-131", "fp", deadline("2d", "overdue")), ("Estate of Margaret Whitfield", "WE-142", "probate", deadline("Today", "today")),
        ("Okafor wills and EPAs", "WE-151", "will", deadline("Thu", "soon")), ("Estate of Robert Chen", "WE-118", "admin", None), ("Estate of Doris Fairweather", "WE-097", "loa", None)])
    body = (f'<div class="mt-mbody" style="gap:8px">{search}<span class="mt-mgroup" style="margin-top:8px">Recent</span><div class="mt-col" style="gap:0">{recent}</div>'
            f'<span class="mt-mgroup">My open matters</span><div class="mt-col" style="gap:0">{view}</div></div>')
    return f'<div class="mt-phone">{statusbar()}{top}{body}{tabbar("matters")}</div>'


def phone_record():
    top = mtop("Record")
    chips = "".join(f'<button class="mt-chip"{" data-selected" if i == 0 else ""} style="min-height:44px;padding:0 12px;font-size:13px;flex:none"><span class="mono-s">{n}</span> {t}</button>' for i, (n, t) in enumerate([("WE-142", "Whitfield"), ("WE-151", "Okafor"), ("WE-118", "Chen")]))
    tiles = "".join(f'<button class="mt-card" style="display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:16px;min-height:120px;text-align:left;font:inherit;cursor:pointer"><span style="display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--bg-selected);color:var(--icon-brand)">{icon(i)}</span><span class="tt" style="font:600 15px/20px var(--font-sans)">{t}</span><span class="caption t-3">{d}</span></button>' for i, t, d in [
        ("timer", "Log time", "Units and a narrative"), ("compose", "Note", "A file note on the matter"), ("camera", "Photo document", "Scan paper pages to a PDF")])
    # A scan saved without a connection waits here until it uploads (MOB-05).
    waiting = ('<span class="mt-mgroup">Waiting to upload</span><div class="mt-col" style="gap:0;border:1px solid var(--border-default);border-radius:var(--radius-lg)">'
               f'<div class="mt-mrow" style="padding:8px 8px 8px 12px"><span style="display:grid;place-items:center;width:32px;height:32px;border-radius:var(--radius-md);background:var(--bg-sunken)">{icon("document")}</span>'
               '<div class="mt-grow"><div class="tt mt-ell">Will – Okafor.pdf</div><div class="ts mt-ell">WE-151 Okafor wills and EPAs · Waiting for a connection</div></div>' + ibtn("trash", "Delete Will – Okafor.pdf") + "</div></div>")
    body = (f'<div class="mt-mbody" style="gap:20px"><div class="mt-col" style="gap:8px"><span class="mt-mgroup">Matter</span><div class="mt-row" style="gap:8px;overflow:hidden">{chips}</div>'
            '<span class="caption t-3">For WE-142 · Estate of Margaret Whitfield.</span></div>'
            f'<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">{tiles}</div><div class="mt-col" style="gap:8px">{waiting}</div></div>')
    return f'<div class="mt-phone">{statusbar()}{top}{body}{tabbar("record")}</div>'


def scan_photo(w, h, quad, page="#F4F1EA"):
    """A photo of a page on a dark desk, with the page's corners as found (MOB-05)."""
    pts = " ".join(f"{x * w:.0f},{y * h:.0f}" for x, y in quad)
    lines = "".join(f'<line x1="{(quad[0][0] + 0.08) * w:.0f}" y1="{(quad[0][1] + 0.12 + i * 0.05) * h:.0f}" x2="{(quad[1][0] - 0.12 - (i % 3) * 0.06) * w:.0f}" y2="{(quad[1][1] + 0.12 + i * 0.05) * h:.0f}" stroke="#8A8378" stroke-width="3"/>' for i in range(12))
    return (f'<svg viewBox="0 0 {w} {h}" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" aria-hidden="true">'
            f'<rect width="{w}" height="{h}" fill="#3B3029"/><polygon points="{pts}" fill="{page}"/>{lines}'
            f'<polygon points="{pts}" fill="none" stroke="var(--border-focus)" stroke-width="4"/></svg>')


def phone_scan_camera():
    """The in-app camera: the back camera full screen, the page's edges as found, the shutter and a page count."""
    quad = [(0.16, 0.14), (0.84, 0.17), (0.88, 0.83), (0.12, 0.8)]
    thumb = '<span style="width:44px;height:56px;border:2px solid #fff;border-radius:var(--radius-sm);background:#F4F1EA"></span>'
    shutter = '<button aria-label="Take photo" style="width:72px;height:72px;border-radius:50%;border:4px solid #fff;background:rgb(255 255 255 / .85);box-shadow:0 0 0 2px rgb(0 0 0 / .4)"></button>'
    top = ('<div class="mt-row" style="position:relative;justify-content:space-between;padding:12px 16px;background:rgb(0 0 0 / .45);color:#fff">'
           + ibtn("x", "Close the camera").replace('class="mt-ibtn"', 'class="mt-ibtn" style="color:#fff"') + '<span style="font:600 15px/20px var(--font-sans)">2 pages</span></div>')
    bottom = ('<div class="mt-row" style="position:relative;justify-content:space-between;padding:12px 16px 28px;background:rgb(0 0 0 / .45)">'
              f'<span style="flex:1;display:flex">{thumb}</span>{shutter}<span style="flex:1;display:flex;justify-content:flex-end">' + btn("Done", "secondary") + "</span></div>")
    view = f'<div style="position:absolute;inset:0">{scan_photo(390, 780, quad)}</div>'
    bar = statusbar().replace('class="mt-statusbar"', 'class="mt-statusbar" style="position:relative;color:#fff"')
    return (f'<div class="mt-phone" style="background:#000;position:relative">{bar}'
            f'{view}<div style="position:relative;flex:1;display:flex;flex-direction:column;justify-content:space-between">{top}{bottom}</div></div>')


def phone_scan_pages():
    """The pages of the scan: drag into order, each straightened (or its corners to adjust), then the details and Add to matter."""
    top = mtop("Scan a document", ibtn("chevron-left", "Back to Record"))
    seg = '<div class="mt-seg"><button class="mt-seg-item" data-selected>Colour</button><button class="mt-seg-item">Black and white</button></div>'
    def row(n, note, tone=None):
        colour = {"warning": "var(--text-warning)"}.get(tone, "var(--text-tertiary)")
        return (f'<div class="mt-row" style="gap:12px;min-height:88px;padding:8px 8px 8px 0;border-top:1px solid var(--border-subtle)">'
                f'<span style="display:grid;place-items:center;width:44px;align-self:stretch" class="t-3">{icon("grip")}</span>'
                '<span style="flex:none;width:52px;height:68px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:#FBFAF7;'
                'background-image:repeating-linear-gradient(transparent 0 9px,#C9C4BA 9px 10px);background-size:70% 100%;background-repeat:no-repeat;background-position:center 8px"></span>'
                f'<div class="mt-grow"><div style="font:600 15px/20px var(--font-sans)">Page {n}</div><div style="font:400 13px/18px var(--font-sans);color:{colour}">{note}</div></div>'
                + ibtn("more", f"Page {n} actions") + "</div>")
    pages = row(1, "Straightened") + row(2, "Straightened") + row(3, "Edges not found. Adjust the corners if it needs cropping.", "warning")
    lst = f'<div class="mt-col" style="gap:0;border:1px solid var(--border-default);border-radius:var(--radius-lg);overflow:hidden;margin-top:-1px">{pages}</div>'
    head = f'<div class="mt-row" style="gap:8px"><span class="label">Pages</span><span class="caption t-3">3 pages</span><span class="mt-ml">{seg}</span></div>'
    add = '<div class="mt-row" style="gap:8px">' + btn("Take photos", "secondary", None, "camera").replace('class="mt-btn"', 'class="mt-btn" style="flex:1"') + btn("Choose photos", "ghost", None, "images").replace('class="mt-btn"', 'class="mt-btn" style="flex:1"') + "</div>"
    matter = ('<div class="mt-col" style="gap:6px"><span class="label">Matter</span><div class="mt-row" style="gap:8px"><span class="mono-s t-2">WE-142</span>'
              '<span class="mt-grow mt-ell body-s">Estate of Margaret Whitfield</span>' + btn("Change", "ghost", "sm") + "</div></div>")
    details = ('<div class="mt-col" style="gap:12px"><span class="label">Details</span>' + matter + field("Name", "Grant of probate – Whitfield", suffix=".pdf")
               + field("Category", "Grant", select=True) + switch(False, "Privileged") + "</div>")
    save = ('<div style="margin:0 -16px;padding:12px 16px;border-top:1px solid var(--border-subtle);background:var(--bg-surface)">'
            + btn("Add to matter", "primary", None, "upload").replace('class="mt-btn"', 'class="mt-btn" style="width:100%"') + "</div>")
    body = f'<div class="mt-mbody" style="gap:16px">{head}{lst}{add}{details}{save}</div>'
    return f'<div class="mt-phone">{statusbar()}{top}{body}{tabbar("record")}</div>'


def phone_scan_crop():
    """Adjust corners: the page's photo in a sheet, a handle on each corner to drag (or move with the arrow keys)."""
    quad = [(0.1, 0.12), (0.9, 0.08), (0.94, 0.9), (0.06, 0.94)]
    handles = "".join(f'<span style="position:absolute;left:{x * 100:.0f}%;top:{y * 100:.0f}%;width:20px;height:20px;margin:-10px 0 0 -10px;border:3px solid var(--border-focus);border-radius:50%;background:var(--bg-surface);box-shadow:0 1px 4px rgb(0 0 0 / .35)"></span>' for x, y in quad)
    frame_ = f'<div style="position:relative;width:260px;height:347px;margin:0 auto">{scan_photo(260, 347, quad)}{handles}</div>'
    under = phone_scan_pages().replace('<div class="mt-phone">', '<div class="mt-phone" style="position:relative">', 1)
    sheet = ('<div class="mt-overlay" style="position:absolute;inset:0"></div><div class="mt-sheet" style="gap:12px"><span class="grab"></span>'
             '<span class="title-m">Adjust the corners of page 3</span><span class="body-s t-2">Drag each corner onto the corner of the page. The page is straightened to fit.</span>'
             f'{frame_}<div class="mt-row" style="gap:8px">' + btn("Use the whole photo", "ghost") + '<span class="mt-ml mt-row" style="gap:8px">' + btn("Cancel", "ghost") + btn("Apply", "primary") + "</span></div></div>")
    return under[: -len("</div>")] + sheet + "</div>"


def phone_more():
    top = mtop("More")
    def row(i, t, tone=None):
        return f'<div class="mt-mrow"{f" data-tone={tone}" if tone else ""}>{icon(i)}<span class="tt mt-grow">{t}</span>{"" if tone else icon("chevron-right", None, "chev")}</div>'
    me = f'<div class="mt-mrow">{avatar("JP", "lg")}<div class="mt-grow"><div class="tt">Jordan Price</div><div class="ts">Lawyer · Hale &amp; Price Lawyers</div></div>{icon("chevron-right", None, "chev")}</div>'
    body = (f'<div class="mt-mbody" style="gap:0">{me}<span class="mt-mgroup">Workspace</span>'
            + "".join(row(i, t) for i, t in [("check-circle", "My tasks"), ("calendar", "Deadlines"), ("contacts", "Contacts"), ("archive", "Safe custody"), ("billing", "Time &amp; billing"), ("insights", "Insights"), ("settings", "Settings")])
            + '<span class="mt-mgroup">This device</span>' + row("moon", "Dark theme") + row("log-out", "Sign out", "danger") + "</div>")
    return f'<div class="mt-phone">{statusbar()}{top}{body}{tabbar("more")}</div>'


def mobile():
    cap = lambda t, d: f'<div class="mt-col" style="gap:2px;width:390px;margin-top:24px"><span class="label">{t}</span><span class="caption t-3">{d}</span></div>'
    rows = [[(phone_today(), "Today", "The brief and this week’s deadlines, readable in one thumb-scroll."),
             (phone_matters(), "Matters", "Search by number, title or client; recent matters, then your view."),
             (phone_matter(), "Matter", "One-tap call, log time and add a note, then the matter in sections.")],
            [(phone_matter(True), "Matter actions", "The top bar’s “…”: a note, time, and calling or emailing the client."),
             (phone_record(), "Record", "Pick a recent matter, then log time, write a note or scan a document. Voice joins the grid; a scan saved offline waits here."),
             (phone_more(), "More", "Everything the TabBar doesn’t hold, your account and this device.")],
            [(phone_scan_camera(), "Scan: camera", "The back camera full screen: each photo is a page, and the count goes on until Done."),
             (phone_scan_pages(), "Scan: pages", "Each photo found and straightened on the phone. Drag into order, colour or black and white, then add to the matter as one PDF."),
             (phone_scan_crop(), "Scan: adjust corners", "When the edges weren’t found, or were found wrong: drag a handle onto each corner of the page.")]]
    out = "".join('<div class="mt-row" style="justify-content:center;gap:56px;align-items:flex-start">' + "".join(f'<div class="mt-col" style="align-items:center;gap:0">{p}{cap(t, d)}</div>' for p, t, d in r) + "</div>" for r in rows)
    return f'<div class="mt" style="width:1440px;min-height:3150px;display:flex;flex-direction:column;gap:56px;padding:64px 0 40px;background:var(--bg-canvas)">{out}</div>'


SCREENS = [
    ("Insights", "How the practice is doing: billing against target, WIP ageing, days to grant, matter mix, utilisation, referral sources and what Clerk contributed.", insights),
    ("Contacts", "One record per person across every matter: their roles, family, contact details and activity, with Clerk spotting a will that needs review.", contacts),
    ("Settings", "Clerk and AI settings: what Clerk can read, what it can do, and where its work happens. Sending, filing and billing stay with people.", settings),
    ("Onboarding", "First-run setup. Bring matters, contacts and safe-custody wills across from the current materia, with Clerk mapping old boards to matter types and stages.", onboarding),
    ("Mobile", "Phone screens: Today, Matters, a matter and its actions, Record, More, and scanning a paper document (camera, pages, adjust corners).", mobile),
]
