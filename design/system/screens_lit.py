"""Litigation screens: Disputes hub, dispute matter, chronology & evidence, settlement & costs, court book."""
from icons import icon, status, priority
from litigation import *
from markup import *
from screens import frame, section_h

NGUYEN = dict(ref="WE-097", type="fp", stage=2, title="Nguyen v Nguyen", sub="Family provision claim in the estate of Thi Nguyen", court="NSWSC 2026/00187412", acting="Acting for the plaintiff", stagename="Evidence")
BRENNAN = dict(ref="WE-171", type="contest", stage=2, title="Doyle v Brennan", sub="Contested will of Harold James Brennan · Probate List", court="NSWSC 2026/00213958", acting="Acting for the defendant (caveator)", stagename="Evidence")
BRENNAN_STAGES = ["Caveat", "Summons filed", "Evidence", "Subpoenas", "Expert reports", "Directions", "Hearing", "Judgment"]


def lit_header(m, active, counts=None, stages=None):
    counts = counts or {}
    tabs = ["Overview", "Orders", "Chronology", "Evidence", "Offers", "Costs", "Court book"]
    tb = "".join(f'<button class="mt-tab"{" data-active" if t == active else ""}>{t}{f"<span class=mt-count>{counts[t]}</span>" if t in counts else ""}</button>' for t in tabs)
    return ('<div class="mt-col" style="gap:10px"><div class="mt-row" style="gap:8px">' + status("active", .4) + f'<span class="mono-s t-3">{m["ref"]}</span>' + tag(m["type"]) + badge(m["stagename"], "brand")
            + f'<span class="mt-issue">{icon("court", "sm")}{m["court"]}</span><span class="caption t-3">{m["acting"]}</span></div>'
            + f'<div class="mt-col" style="gap:2px"><h1 class="title-l" style="margin:0">{m["title"]}</h1><span class="body-s t-3">{m["sub"]}</span></div>'
            + lit_stepper(m["stage"], stages or LIT_STAGES) + "</div>" + f'<div class="mt-tabs">{tb}</div>')


def clerk_av(size="sm"):
    return avatar(kind="clerk", size=size)


def card(title, body, right="", style=""):
    return f'<div class="mt-card" data-pad style="{style}">{section_h(title, right)}{body}</div>'


# ------------------------------------------------------------------ Disputes hub
def disputes():
    rows = [
        ("WE-097", "Nguyen v Nguyen", "For the plaintiff · Ho Legal acts for the executor", tag("fp"), ("active", .3), "Evidence", "NSWSC 2026/00187412", deadline("Affidavit 2d late", "overdue"), 86, "danger"),
        ("WE-171", "Doyle v Brennan", "For the defendant (caveator) · Carlisle &amp; Webb for the plaintiff", tag("contest"), ("active", .3), "Evidence", "NSWSC 2026/00213958", deadline("Directions Fri 9 Oct", "soon"), 48, None),
        ("WE-188", "Estate of Rosa Marchetti", "For a beneficiary · executor not administering", tag("contest", "Estate dispute"), ("draft", 0), "Pre-action", "Not yet filed", deadline("Reply due 12 Oct", "upcoming"), 22, None),
    ]
    body = "".join(f'<tr><td class="ref">{r}</td><td><div class="title">{n}</div><div class="caption t-3">{w}</div></td><td>{t}</td><td><span class="mt-row" style="gap:6px">{status(*st)}<span class="t-2">{sn}</span></span></td><td class="mono-s t-3">{ct}</td><td>{dl}</td>'
                   f'<td style="width:130px"><div class="mt-row" style="gap:8px">{progress(p, tone)}<span class="mono-s t-3" style="width:28px;text-align:right">{p}%</span></div></td></tr>'
                   for r, n, w, t, st, sn, ct, dl, p, tone in rows)
    table = f'<div class="mt-card" style="overflow:hidden"><table class="mt-table"><thead><tr><th>Ref</th><th>Dispute</th><th>Type</th><th>Stage</th><th>Court</th><th>Next</th><th>Costs v estimate</th></tr></thead><tbody>{body}</tbody></table></div>'
    watch = ('<div class="mt-card" data-pad>' + section_h('To watch <span class="mt-count">1</span>', '<span class="caption t-3">Claims that could still be made against estates we act for</span>')
             + '<div class="mt-col" style="gap:16px"><div class="mt-col" style="gap:6px"><div class="mt-row" style="gap:8px">' + tag("probate") + '<span class="label">Estate of Margaret Whitfield</span><span class="mono-s t-3">WE-142</span></div>'
             + '<div class="body-s t-2">Thomas Whitfield (son) is an eligible person who is left nothing by clause 6. He has asked for a copy of the will. A family provision claim can be filed until <b class="t-1">22 Jul 2027</b>.</div>'
             + '<div class="mt-cites">' + cite("Will · cl. 6") + cite("File note 14 Aug") + cite("Succession Act s 58(2)") + "</div></div>"
             + '<div class="mt-col" style="gap:6px"><div class="mt-row caption t-3"><span>Limitation period</span><span class="mt-ml mono">293 days left</span></div>' + progress(20) + '<span class="caption t-3">Advise the executors not to distribute before the period ends (s 93 notice).</span>'
             + '<div class="mt-row" style="gap:6px">' + btn("Draft advice to executors", "ai", "sm", "sparkle") + "</div></div></div></div>")
    cal = "".join([
        court_event("Fri", "9", "Oct", "Registrar’s directions", "Doyle v Brennan · 9:30 am · timetable for expert evidence", [("external", "Online · Teams")], "directions", badge("Ready", "success")),
        court_event("Fri", "23", "Oct", "Subpoena return", "Doyle v Brennan · Dr Patel’s records, Sep 2023–Mar 2024", [("court", "Registry · access order")], "directions"),
        court_event("Thu", "26", "Nov", "Mediation", "Nguyen v Nguyen · 10:00 am · A. Ruiz, mediator", [("contacts", "Sydney CBD · client attends")], "mediation", badge("Position paper", "ai", "sparkle")),
        court_event("Fri", "4", "Dec", "Further directions", "Nguyen v Nguyen · 9:30 am · Family Provision List", [("external", "Online · Teams")], "directions"),
        court_event("Tue", "9", "Mar", "Hearing, 3 days", "Doyle v Brennan · 9–11 Mar 2027", [("user", "Counsel: J. Mercer SC")], "hearing", badge("Brief 40%", "warning"))])
    right = ('<div class="mt-col" style="gap:12px"><div class="mt-card-h"><h3>Court calendar</h3><span class="mt-ml">' + btn("Sync to Outlook", "ghost", "sm", "external") + "</span></div>" + cal + "</div>")
    stats = ('<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">' + stat("Active proceedings", "2", "Family provision 1 · Will dispute 1") + stat("Pre-action", "1", "Letter of demand sent 21 Sep")
             + stat("Court events, 60 days", "4", "Next: Fri 9 Oct, directions") + stat("Costs over 80% of estimate", "1", '<span class="t-danger">Nguyen · update disclosure</span>') + "</div>")
    page = ('<div class="mt-page"><div class="mt-row" style="align-items:flex-end"><div class="mt-col" style="gap:4px"><h1 class="title-l" style="margin:0">Disputes</h1><span class="body-s t-3">Contested estates: family provision claims, will disputes and estate administration disputes</span></div></div>'
            + stats + table + f'<div style="display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:20px;align-items:start">{watch}{right}</div></div>')
    actions = btn("Check a will for dispute risk", "ai", "sm", "sparkle") + btn("New dispute", "primary", "sm", "plus")
    return frame("disputes", ["Disputes"], actions, page)


# ------------------------------------------------------------------ Dispute matter (Nguyen)
def dispute_matter():
    orders = ('<div class="mt-card" data-pad>' + section_h('Orders made 12 Sep 2026 <span class="caption t-3" style="font-weight:400">· Registrar, Family Provision List</span>', cite("Sealed orders PDF"))
              + order("1", "The plaintiff is to file and serve any affidavit evidence on which she relies by 30 September 2026.", "Deadline · our evidence", deadline("Overdue 2d", "overdue"))
              + order("2", "The defendant is to file and serve an affidavit as to the estate’s assets and liabilities and the persons notified, by 28 October 2026.", "Deadline · their evidence", deadline("28 Oct", "upcoming"))
              + order("3", "The plaintiff is to file and serve any evidence in reply by 11 November 2026.", "Deadline · our reply", deadline("11 Nov", "upcoming"))
              + order("4", "The parties are to attend a mediation by 27 November 2026.", "Court event · mediation booked 26 Nov", deadline("26 Nov", "upcoming"))
              + order("5", "The defendant is to notify the Court of the outcome of the mediation within 7 days after it concludes.", "Becomes 3 Dec once the mediation happens on 26 Nov", badge("Date depends", "warning"), True)
              + order("6", "The proceedings are listed for further directions on 4 December 2026 at 9:30 am.", "Court event", deadline("4 Dec", "upcoming"))
              + "</div>")
    parties = ('<div class="mt-card" data-pad>' + section_h("Parties")
               + "".join(f'<div class="mt-row" style="gap:10px;padding:6px 0">{avatar(a, "lg", hue=h)}<div class="mt-grow"><div class="label">{n}</div><div class="caption t-3">{r}</div></div>{x}</div>' for a, h, n, r, x in [
                   ("LN", None, "Lan Nguyen", "Plaintiff · daughter · our client", badge("Client", "brand")), ("MN", "3", "Minh Nguyen", "Defendant · executor and son · Ho Legal (Kevin Ho)", ""),
                   ("BN", "2", "Bao Nguyen", "Eligible person notified · not a party", "")]) + "</div>")
    glance = ('<div class="mt-card" data-pad>' + section_h("Claim at a glance") + '<dl class="mt-facts"><dt>Deceased</dt><dd>Thi Nguyen · died 14 Nov 2025</dd><dt>Estate</dt><dd>$1.92m · house at Cabramatta $1.45m</dd><dt>Under the will</dt><dd>Lan 20% ($384k) · Minh 80%</dd><dt>Claim filed</dt><dd>10 Jul 2026, within 12 months ' + icon("check", "sm", "t-success") + "</dd><dt>Our costs</dt><dd>$18,920 of the $22,000 estimate</dd></dl>"
              + progress(86, "danger") + '<div class="mt-note" data-tone="warning">' + icon("alert") + '<span>Costs to mediation are projected at $24,500. Update the costs disclosure before the estimate is exceeded.</span></div></div>')
    nxt = ('<div class="mt-col" style="gap:8px">' + court_event("Thu", "26", "Nov", "Mediation", "10:00 am · Angela Ruiz, mediator · client to attend", [("contacts", "Sydney CBD"), ("document", "Position paper due 19 Nov")], "mediation")
           + court_event("Fri", "4", "Dec", "Further directions", "9:30 am · Family Provision List", [("external", "Online · Teams")], "directions") + "</div>")
    left = ('<div class="mt-page" style="padding-right:28px;min-width:0">' + lit_header(NGUYEN, "Overview", {"Orders": 6, "Offers": 2})
            + f'<div style="display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:16px;align-items:start"><div class="mt-col" style="gap:16px">{orders}{parties}</div><div class="mt-col" style="gap:16px">{glance}<div class="mt-card" data-pad>{section_h("Next in court")}{nxt}</div></div></div></div>')
    panel = ('<aside style="width:400px;flex:none;border-left:1px solid var(--border-default);display:flex;flex-direction:column;background:linear-gradient(180deg,var(--bg-ai-subtle),var(--bg-surface) 160px)">'
             + '<div class="mt-row" style="height:48px;padding:0 8px 0 16px;border-bottom:1px solid var(--border-default)">' + clerk_av() + '<span class="label">Clerk</span><span class="caption t-3">Reading WE-097 · 64 documents</span><span class="mt-ml">' + ibtn("x", "Close Clerk", size="sm") + "</span></div>"
             + '<div class="mt-col" style="gap:18px;padding:20px 16px;flex:1">'
             + '<div class="mt-msg" data-role="clerk">' + clerk_av() + '<div class="body"><p><b>The sealed orders arrived from the Online Registry.</b> I’ve proposed 5 deadlines and 2 court events from them. Order 5 depends on the mediation date, so I’ve held it until the mediation happens.</p>'
             + '<div class="mt-row">' + btn("Review 7 items", "secondary", "sm") + btn("Add all", "ai", "sm", "check") + "</div></div></div>"
             + '<div class="mt-msg" data-role="clerk">' + clerk_av() + '<div class="body"><p><b>Lan’s affidavit is 2 days late</b> under order 1. Ho Legal agreed to a 7-day extension by email yesterday, so this can go by consent.<sup>1</sup></p><div class="mt-cites">' + cite("Email · K. Ho 1 Oct", 1) + '</div><div class="mt-row">' + btn("Draft consent orders", "ai", "sm", "sparkle") + btn("Draft cover letter", "ghost", "sm") + "</div></div></div>"
             + '<div class="mt-msg" data-role="user">What does Lan’s affidavit still need?</div>'
             + '<div class="mt-msg" data-role="clerk">' + clerk_av() + '<div class="body"><p>The draft covers her relationship with her mother and her health. Against the s 60(2) factors, it’s thin on <b>her financial position</b>:<sup>2</sup></p><ul><li>No superannuation statement or 2025 tax return in the file.</li><li>Paragraph 18 mentions a mortgage but no loan statement is exhibited.<sup>3</sup></li><li>Her son’s school fees are claimed without receipts.</li></ul><div class="mt-cites">' + cite("Succession Act s 60(2)", 2) + cite("Draft affidavit [18]", 3) + '</div><div class="mt-row">' + btn("Request documents from Lan", "ai", "sm", "mail") + "</div></div></div>"
             + "</div>"
             + '<div style="padding:0 12px 12px"><div class="mt-composer"><span class="ctx">' + icon("court") + "WE-097 · Nguyen v Nguyen" + icon("x") + '</span><div class="field">Ask about this dispute…</div><div class="bar">' + ibtn("attach", "Attach", size="sm") + '<span class="mt-grow"></span><button class="mt-send" aria-label="Send">' + icon("send") + "</button></div></div></div></aside>")
    page = f'<div style="display:flex;flex:1;min-height:0">{left}{panel}</div>'
    actions = btn("Record time", "secondary", "sm", "timer", ["T"]) + btn("File document", "primary", "sm", "upload") + ibtn("more", "More", size="sm")
    return frame("disputes", ["Disputes", "WE-097", "Nguyen v Nguyen"], actions, page)


# ------------------------------------------------------------------ Chronology & evidence (Brennan)
def chronology():
    items = ('<div class="mt-chrono">'
             + '<div class="mt-chrono-year">2019</div>'
             + chrono("12 Mar", "Harold makes a will leaving his estate equally to his children, Ruth and Michael.", ["Will 2019", "Moran Lawyers file"], [], True)
             + '<div class="mt-chrono-year">2023</div>'
             + chrono("3 Jun", "GP records an MMSE score of 21/30 and refers Harold to a geriatrician.", ["Dr Patel records p 14"], ["cap"])
             + chrono("22 Aug", "Geriatrician diagnoses moderate Alzheimer’s disease and recommends he not manage his own finances.", ["Dr Wong report p 2"], ["cap"], True)
             + chrono("Nov", "Gary Doyle, a neighbour, begins daily visits and is given authority over Harold’s Westpac accounts.", ["Westpac authority form", "R. Brennan aff. [14]"], ["ui"])
             + '<div class="mt-chrono-gap">' + suggestion("No medical records between Aug 2023 and Mar 2024", "Clerk · the 2024 will was made in this window. A subpoena to Dr Patel for that period would fill it.", "Draft subpoena") + "</div>"
             + '<div class="mt-chrono-year">2024</div>'
             + chrono("15 Feb", "Doyle drives Harold to Ainsworth &amp; Co. Instructions for a new will are taken with Doyle in the room.", ["Ainsworth statement p 3"], ["ui", "ka"], True)
             + chrono("4 Mar", "Harold signs a new will leaving his whole estate to Gary Doyle. Witnessed by two staff of Ainsworth &amp; Co.", ["Will 2024", "Ainsworth statement p 5"], ["cap", "ka"], True)
             + '<div class="mt-chrono-year">2026</div>'
             + chrono("11 Jan", "Harold dies, aged 88.", ["Death certificate"])
             + chrono("2 Mar", "Ruth lodges a caveat against a grant of probate of the 2024 will.", ["Caveat"])
             + chrono("14 Jul", "Doyle commences proceedings for probate of the 2024 will in solemn form.", ["Summons"], [], True)
             + "</div>")
    filters = ('<div class="mt-row mt-wrap" style="gap:6px">' + "".join(f'<button class="mt-chip"{" data-selected" if i == 0 else ""}>{t}</button>' for i, t in enumerate(["All issues", "C · Capacity", "K · Knowledge and approval", "U · Undue influence"]))
               + '<span class="mt-ml mt-row" style="gap:6px"><span class="caption t-3">Built from 112 documents · 3 need review</span>' + switch(False, "Key events only") + "</span></div>")
    left = ('<div class="mt-page" style="padding-right:28px;min-width:0">' + lit_header(BRENNAN, "Chronology", {"Evidence": 9}, BRENNAN_STAGES)
            + filters + '<div class="mt-card" data-pad style="padding-top:4px">' + items + "</div></div>")
    mx = matrix([("Testamentary capacity (Banks v Goodfellow)", [
                     ("Understood making a will and its effect", cite("Ainsworth stmt p 3") + " " + cite("Dr Wong p 2"), "moderate"),
                     ("Knew the extent of his property", cite("Westpac authority"), "strong"),
                     ("Appreciated the claims of his children", '<span class="t-3">No direct evidence</span>', "gap"),
                     ("No disorder of mind affecting the gift", cite("Dr Wong p 2") + " " + cite("Patel p 14"), "strong")]),
                 ("Knowledge and approval", [("Suspicious circumstances", cite("Ainsworth stmt p 3"), "strong"), ("Will read over or explained", '<span class="t-3">Ainsworth file notes requested</span>', "gap")]),
                 ("Undue influence (coercion)", [("Coercion, not mere persuasion", cite("R. Brennan aff. [14]"), "weak")])])
    right = ('<aside style="width:460px;flex:none;border-left:1px solid var(--border-default);padding:20px 16px;display:flex;flex-direction:column;gap:16px">'
             + '<div class="mt-card-h"><h3>Evidence by issue</h3><span class="mt-ml">' + btn("Export", "ghost", "sm", "upload") + "</span></div>" + mx
             + '<div class="mt-col" style="gap:8px"><span class="heading">Next to gather</span>'
             + suggestion("Subpoena Dr Patel: records Sep 2023 to Mar 2024", "Fills the medical gap around the will (UCPR Pt 33)", "Draft subpoena")
             + suggestion("Ask Ainsworth &amp; Co for the will file and notes", "Larke v Nugus request: who gave instructions, and how the will was explained", "Draft request")
             + suggestion("Brief a retrospective capacity expert", "Old-age psychiatrist to report on Harold’s capacity at 4 Mar 2024", "Draft brief")
             + '</div><div class="caption t-3">Strength is the fee earner’s judgement. Clerk proposes it with reasons; you set it.</div></aside>')
    page = f'<div style="display:flex;flex:1;min-height:0">{left}{right}</div>'
    actions = btn("Export chronology", "secondary", "sm", "upload") + btn("Add event", "primary", "sm", "plus")
    return frame("disputes", ["Disputes", "WE-171", "Chronology"], actions, page)


# ------------------------------------------------------------------ Settlement & costs (Nguyen)
def settlement():
    offers = ('<div class="mt-col" style="gap:8px">'
              + offer("Our client", "18 Sep", "Offer of compromise · UCPR r 20.26", "$260,000", "Plus costs as agreed or assessed, from the estate. Open for 28 days.", deadline("Open until Fri 16 Oct", "soon"), "ours", btn("View letter", "ghost", "sm"))
              + offer("Ho Legal for the defendant", "18 Aug", "Calderbank offer", "$120,000", "Inclusive of costs. Each party otherwise bears their own.", badge("Rejected 1 Sep"), "theirs")
              + '<div class="mt-suggestion">' + clerk_av() + '<div class="mt-grow"><div class="tt">Mediation position paper drafted</div><div class="ts">From Lan’s affidavit, the estate figures and both offers · due 19 Nov</div></div>' + btn("Open draft", "ai", "sm") + "</div></div>")
    sc = scenarios([("Accept their $120,000", "Inclusive of costs; ours to mediation about $24.5k", 95.5), ("Settle at mediation", "About $210k plus costs from the estate", 210),
                    ("Our offer accepted", "$260k plus costs", 260), ("Hearing, provision ordered", "About $280k, less unrecovered costs, mid 2027", 252),
                    ("Hearing, claim dismissed", "Own costs to hearing, no costs order", -58)], -80, 290)
    costs = ('<div class="mt-col" style="gap:10px">' + "".join(f'<div class="mt-row"><span class="body-s t-2 mt-grow">{k}</span><span class="mono">{v}</span></div>' for k, v in [("Costs to date", "$18,920"), ("Disclosed estimate", "$22,000"), ("Projected to mediation", "$24,500"), ("Projected to hearing", "$58,000")])
             + progress(86, "danger") + '<div class="mt-row">' + btn("Update costs disclosure", "ai", "sm", "sparkle") + '<span class="caption t-3 mt-ml">Uniform Law Pt 4.3</span></div></div>')
    left = ('<div class="mt-page">' + lit_header(NGUYEN, "Offers", {"Orders": 6, "Offers": 2})
            + '<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:16px;align-items:start">'
            + '<div class="mt-col" style="gap:16px">' + card("Offers", offers, btn("Record offer", "ghost", "sm", "plus")) + card("Costs", costs) + "</div>"
            + '<div class="mt-col" style="gap:16px">' + card("What Lan nets under each outcome", '<div class="caption t-3" style="margin-top:-6px">After her own costs. Estimates from this matter’s costs and the estate figures, not a prediction.</div>' + sc
                                                          + '<details class="mt-tableview"><summary>View as table</summary><table class="mt-table"><thead><tr><th>Scenario</th><th class="num">Net to client</th></tr></thead><tbody><tr><td>Accept $120,000</td><td class="num">$95,500</td></tr><tr><td>Settle at mediation</td><td class="num">$210,000</td></tr><tr><td>Our offer accepted</td><td class="num">$260,000</td></tr><tr><td>Hearing, provision ordered</td><td class="num">$252,000</td></tr><tr><td>Hearing, claim dismissed</td><td class="num">−$58,000</td></tr></tbody></table></details>')
            + '<div class="mt-clerk-card"><div class="in"><div class="mt-clerk-head">' + clerk_av() + 'Before the mediation</div><div class="body-s t-2">Our offer of compromise expires on <b class="t-1">16 Oct</b>. If it lapses and the result at hearing is no less favourable, the costs consequences under UCPR r 42.15 may apply. Diarise a review on 13 Oct.</div><div class="mt-cites">' + cite("UCPR r 20.26") + cite("UCPR r 42.15") + '</div><div class="mt-row">' + btn("Add review task", "ai", "sm", "plus") + "</div></div></div>"
            + "</div></div></div>")
    actions = btn("Record time", "secondary", "sm", "timer", ["T"]) + btn("Prepare for mediation", "primary", "sm", "contacts")
    return frame("disputes", ["Disputes", "WE-097", "Offers"], actions, left)


# ------------------------------------------------------------------ Court book (Brennan)
def court_book():
    tbl = bundle_table([
        ("1", "Originating process", [("1.1", "Summons for probate in solemn form", "14 Jul 2026", "Plaintiff", "1–6", "", False)]),
        ("2", "Orders", [("2.1", "Orders of the Registrar", "11 Aug 2026", "Court", "7–8", "", False)]),
        ("3", "Affidavits", [("3.1", "Affidavit of Gary Doyle", "21 Jul 2026", "Plaintiff", "9–41", "", False),
                             ("3.2", "Affidavit of Susan Ainsworth (drafting solicitor)", "21 Jul 2026", "Plaintiff", "42–77", "", False),
                             ("3.3", "Affidavit of Ruth Brennan", "2 Sep 2026", "Defendant", "78–131", "", False)]),
        ("4", "Wills and medical records", [("4.1", "Will dated 12 March 2019", "12 Mar 2019", "Defendant", "132–139", "", False), ("4.2", "Will dated 4 March 2024", "4 Mar 2024", "Plaintiff", "140–146", "", False),
                                            ("4.3", "Dr Wong, geriatric assessment", "22 Aug 2023", "Subpoena", "147–152", "", False), ("4.4", "Dr Patel, clinical notes 2022–2023", "—", "Subpoena", "153–318", "", False)]),
        ("5", "Correspondence", [("5.1", "Carlisle &amp; Webb to Hale &amp; Price", "14 Aug 2026", "—", "319–321", "", False),
                                 ("—", "Hale &amp; Price to Carlisle &amp; Webb (without prejudice)", "28 Aug 2026", "—", "excluded", badge("Without prejudice", "warning"), True),
                                 ("—", "File note: conference with Ruth Brennan", "3 Mar 2026", "—", "excluded", badge("Privileged", "warning"), True)])])
    checks = ('<aside style="width:400px;flex:none;border-left:1px solid var(--border-default);padding:20px 16px;display:flex;flex-direction:column;gap:14px">'
              + '<div class="mt-card-h"><h3>Court book</h3><span class="mt-ml">' + deadline("Hearing 9 Mar 2027", "upcoming") + "</span></div>"
              + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">' + "".join(f'<div class="mt-col" style="gap:0;padding:10px;border-radius:8px;background:var(--bg-canvas)"><span class="numeric-m">{v}</span><span class="caption t-3">{k}</span></div>' for v, k in [("321", "pages"), ("13", "documents"), ("2", "excluded")])
              + "</div>"
              + '<div class="mt-col" style="gap:8px"><span class="mt-clerk-head">' + clerk_av() + "Clerk checked the bundle</span>"
              + '<div class="mt-note" data-tone="danger">' + icon("alert") + '<span><b>Exhibit RB-3 is missing.</b> Ruth’s affidavit refers to it at [22] (her 2023 letter to Harold), but it isn’t in tab 3.</span></div>'
              + '<div class="mt-note" data-tone="warning">' + icon("shield") + '<span><b>2 documents kept out:</b> a without prejudice letter and a privileged file note. They won’t be in the PDF.</span></div>'
              + '<div class="mt-note">' + icon("copy") + '<span><b>Duplicate removed:</b> Dr Patel’s June 2023 notes were in both subpoena responses. One copy kept at 4.4.</span></div>'
              + '<div class="mt-note">' + icon("check") + "<span>Page numbers run 1–321 with no gaps. Every affidavit’s exhibits are paginated.</span></div></div>"
              + '<div class="mt-col" style="gap:8px;margin-top:auto">' + btn("Hearing brief for counsel", "secondary", None, "document") + btn("Generate court book PDF", "primary", None, "upload") + '<span class="caption t-3">Generating doesn’t send anything. You serve or file it.</span></div></aside>')
    left = ('<div class="mt-page" style="padding-right:28px;min-width:0">' + lit_header(BRENNAN, "Court book", {"Evidence": 9}, BRENNAN_STAGES)
            + '<div class="mt-row" style="gap:6px">' + chip_row() + '</div><div class="mt-card" style="overflow:hidden">' + tbl + "</div></div>")
    page = f'<div style="display:flex;flex:1;min-height:0">{left}{checks}</div>'
    return frame("disputes", ["Disputes", "WE-171", "Court book"], btn("Add document", "secondary", "sm", "plus"), page)


def chip_row():
    return '<button class="mt-chip" data-selected>Hearing 9 Mar 2027</button><button class="mt-chip">Mediation bundle</button><button class="mt-chip" data-variant="filter">' + icon("plus") + "New bundle</button>"


SCREENS = [
    ("Disputes", "Every contested estate in one place: stage, court and proceedings number, next event, costs against estimate, the court calendar, and claims still within their limitation period.", disputes),
    ("Dispute matter", "A family provision claim: court orders turned into deadlines, parties and representatives, the claim at a glance, next court events, and Clerk working through late evidence.", dispute_matter),
    ("Chronology and evidence", "A will dispute’s chronology built from the file with sources and issue tags, gaps flagged, and evidence mapped to each element of capacity, knowledge and approval, and undue influence.", chronology),
    ("Settlement and costs", "Offers made and received with expiry, costs against the disclosed estimate, and what the client nets under each outcome.", settlement),
    ("Court book", "The hearing bundle as an index: tabs, page ranges, privileged and without prejudice material kept out, and Clerk’s checks for missing exhibits and duplicates.", court_book),
]
