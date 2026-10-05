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
    # Sidebar order follows the app's SETTINGS_SECTIONS (CORE-21); Account, Trust, Rule sets, Integrations and Security are designed ahead (DES-01).
    groups = [("Account", [("Profile", "user"), ("Preferences", "settings"), ("Notifications", "bell")]),
              ("Firm", [("Practice", "matters"), ("Team and roles", "contacts"), ("Billing and rates", "billing"), ("Trust account", "lock")]),
              ("Practice", [("Matter numbering", "list"), ("Matter templates", "board"), ("Rule sets", "scale")]),
              ("Clerk", [("Clerk and AI", "sparkle")]),
              ("Connections", [("Integrations", "link"), ("Security", "shield")]),
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
    items = [("today", "Today", "today"), ("matters", "Matters", "matters"), ("rec", "", "mic"), ("clerk", "Clerk", "sparkle"), ("inbox", "Inbox", "inbox")]
    out = []
    for k, l, i in items:
        if k == "rec":
            out.append(f'<a aria-label="Record"><span class="fab">{icon(i)}</span></a>')
        else:
            out.append(f'<a{" data-active" if k == active else ""}>{icon(i)}{l}</a>')
    return f'<nav class="mt-tabbar">{"".join(out)}</nav>'


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


def phone_matter(dim=False):
    top = '<div class="mt-mtop">' + ibtn("chevron-left", "Back") + '<span class="tl"><span class="mono-s t-3">WE-142</span></span>' + ibtn("more", "More") + "</div>"
    actions = "".join(f'<button class="mt-btn" data-variant="{v}" style="flex-direction:column;height:64px;flex:1;gap:4px;font-size:12px">{icon(i)}{l}</button>' for i, l, v in [("phone", "Call executor", "secondary"), ("timer", "Record time", "secondary"), ("sparkle", "Ask Clerk", "ai")])
    body = ('<div class="mt-mbody"><div class="mt-col" style="gap:8px"><div class="mt-row" style="gap:6px">' + tag("probate") + badge("Notice period", "brand") + '</div><span class="title-l" style="font-size:22px;line-height:28px">Estate of Margaret Whitfield</span>'
            '<div class="mt-row" style="gap:10px"><div class="mt-progress mt-grow" data-size="md"><div class="mt-progress-bar" style="width:28%"></div></div><span class="caption t-3">Stage 3 of 9 · Notice</span></div></div>'
            '<div class="mt-card" data-pad style="background:var(--bg-selected);border-color:transparent"><div class="mt-row"><span class="label">Next</span><span class="mt-ml">' + deadline("Today", "today") + '</span></div><div class="body">Publish notice of intended application</div><div class="caption t-3">A&amp;P Rules 2014 · filing opens 16 Oct</div>'
            + btn("Publish notice", "primary", "lg", "court").replace('class="mt-btn"', 'class="mt-btn" style="width:100%"') + "</div>"
            f'<div class="mt-row" style="gap:8px">{actions}</div>'
            '<div class="mt-col" style="gap:0"><span class="heading" style="padding-bottom:4px">Key people</span>'
            + "".join(f'<div class="mt-mrow">{avatar(a, "lg", hue=h)}<div class="mt-grow"><div class="tt">{n}</div><div class="ts">{r}</div></div>{x}</div>' for a, h, n, r, x in [("CW", None, "Catherine Whitfield", "Executor · daughter", icon("phone", None, "t-brand")), ("PH", "2", "Peter Hale", "Executor · accountant", icon("phone", None, "t-brand")), ("TW", "risk", "Thomas Whitfield", "Son · not provided for", badge("FP risk", "danger"))])
            + "</div></div>")
    ov = ""
    if dim:
        ov = ('<div class="mt-overlay" style="position:absolute;inset:0"></div><div class="mt-sheet"><span class="grab"></span>'
              '<div class="mt-row"><span class="title-m">Recording</span><span class="mt-ml mono t-3">0:14</span></div>'
              '<div class="mt-wave">' + "".join(f'<i style="height:{h}px"></i>' for h in [8, 14, 22, 30, 18, 36, 44, 28, 16, 34, 40, 24, 12, 20, 32, 26, 14, 8, 18, 28, 36, 22, 12, 6]) + "</div>"
              '<p class="body-l t-2" style="margin:0">“Called Peter Hale about the share registry statements for the Chen estate, about ten minutes.”</p>'
              '<div class="mt-col" style="gap:6px"><span class="mt-clerk-head">' + avatar(kind="clerk", size="sm") + "Clerk made this entry</span>"
              + time_entry("Call with Peter Hale re: share registry", "WE-118 · Estate of Robert Chen", "0.2 h", "$88.00", "phone", True, False) + "</div>"
              '<div class="mt-row" style="gap:8px">' + btn("Discard", "ghost", "lg").replace('class="mt-btn"', 'class="mt-btn" style="flex:1"') + btn("Save entry", "primary", "lg", "check").replace('class="mt-btn"', 'class="mt-btn" style="flex:2"') + "</div></div>")
    return f'<div class="mt-phone">{statusbar()}{top}{body}{tabbar("matters")}{ov}</div>'


def mobile():
    cap = lambda t, d: f'<div class="mt-col" style="gap:2px;width:390px;margin-top:24px"><span class="label">{t}</span><span class="caption t-3">{d}</span></div>'
    cols = [(phone_today(), "Today", "The brief and this week’s deadlines, readable in one thumb-scroll."),
            (phone_matter(), "Matter", "The next statutory step first, with one-tap call, record and Ask Clerk."),
            (phone_matter(True), "Record by voice", "Say what you did. Clerk picks the matter, units and narrative; you save it.")]
    inner = "".join(f'<div class="mt-col" style="align-items:center;gap:0">{p}{cap(t, d)}</div>' for p, t, d in cols)
    return f'<div class="mt" style="width:1440px;min-height:1020px;display:flex;justify-content:center;gap:56px;padding:64px 0 40px;background:var(--bg-canvas)">{inner}</div>'


SCREENS = [
    ("Insights", "How the practice is doing: billing against target, WIP ageing, days to grant, matter mix, utilisation, referral sources and what Clerk contributed.", insights),
    ("Contacts", "One record per person across every matter: their roles, family, contact details and activity, with Clerk spotting a will that needs review.", contacts),
    ("Settings", "Clerk and AI settings: what Clerk can read, what it can do, and where its work happens. Sending, filing and billing stay with people.", settings),
    ("Onboarding", "First-run setup. Bring matters, contacts and safe-custody wills across from the current materia, with Clerk mapping old boards to matter types and stages.", onboarding),
    ("Mobile", "Phone screens: Today, a matter, and recording time by voice.", mobile),
]
