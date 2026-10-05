"""Fourth-pass screens (DES-01): Inbox, unfiled email, notifications, Clerk full page, tablet layouts and system states."""
from components_pass4 import banner, day, notif, skel
from icons import icon, status, priority
from markup import *
from screens import MATTERS, frame, matters_list, section_h, sidebar
from screens_next import card, chip

FOOT = '<div class="mt-clerk-foot">' + icon("info", "sm") + "Clerk can be wrong. Check the citations.</div>"


def seg(items, sel):
    return '<div class="mt-seg">' + "".join(f'<button class="mt-seg-item"{" data-selected" if i == sel else ""}>{l}</button>' for i, l in enumerate(items)) + "</div>"


def inbox_seg(sel):
    return seg([icon("bell") + "Notifications", icon("mail") + 'Unfiled email <span class="mt-count">5</span>'], sel)


# ------------------------------------------------------------------ Inbox
def inbox():
    rows = (day("Today · Mon 5 Oct", 5)
            + notif("mention", "<b>Priya Shah</b> mentioned you on <b>WE-142 · Estate of Margaret Whitfield</b>", "“@Jordan can you check the asset schedule before I send it to Peter Hale?”", "9:14 am", True, True, select=True)
            + notif("overdue", "<b>Serve plaintiff’s affidavit</b> is 2 days overdue", "WE-097 · Nguyen v Nguyen · orders 12 Sep, para 3", "8:00 am", True, True, select=True)
            + notif("deadline", "<b>Publish notice of intended application</b> is due today", "WE-142 · A&amp;P Rules 2014 · 14 days before filing", "7:30 am", True, False, select=True)
            + notif("clerk", "<b>Clerk</b> drafted 6 time entries from yesterday", "2.1 h to review · nothing bills until you accept", "7:02 am", False, False, side=btn("Review", "ai", "sm"), select=True)
            + notif("court", "<b>Sealed orders</b> arrived for <b>Doyle v Brennan</b>", "RedCrest · Clerk proposed 5 deadlines and 2 court events", "6:48 am", False, False, select=True)
            + day("Yesterday", 4)
            + notif("assignment", "<b>Daniel Kim</b> assigned you <b>Search for next of kin</b>", "WE-133 · Estate of Doris Fairweather · due Mon 12 Oct", "4:51 pm", False, False, select=True)
            + notif("mention", "<b>Alexandra Konstantinidou-Fitzwilliam</b> replied on <b>WE-171 · Doyle v Brennan</b>", "“The expert’s CV is in the court book draft now, tab 4.”", "2:10 pm", False, False, select=True)
            + notif("clerk", "<b>Clerk</b> found a will that needs review", "Catherine Whitfield’s will names her late mother as substitute executor (WE-031)", "11:32 am", False, False, select=True)
            + notif("deadline", "<b>Will and EPA signing</b> is on Thursday", "WE-151 · Harriet and Paul Okafor · 10:00 am · two witnesses", "9:00 am", False, False, select=True)
            + day("Wednesday 30 Sep", 1)
            + notif("assignment", "<b>Priya Shah</b> assigned you <b>WE-160 · Estate of George Lambert</b>", "New matter from intake · probate", "3:15 pm", False, False, select=True))
    toolbar = ('<div class="mt-row mt-wrap" style="padding:10px 16px;border-bottom:1px solid var(--border-default);gap:6px">' + chip("All 10", selected=True) + chip("Mentions 2", "at-sign") + chip("Assigned to me 2", "user-plus")
               + chip("Deadlines 3", "clock") + chip("Clerk 2", "sparkle") + '<span class="mt-ml">' + switch(True, "Unread first") + "</span></div>")
    bulk = ('<div style="position:absolute;left:50%;bottom:24px;transform:translateX(-50%);display:flex;align-items:center;gap:4px;padding:6px 6px 6px 14px;border-radius:10px;background:var(--bg-inverse);color:var(--text-inverse);box-shadow:var(--shadow-dialog)">'
            '<span class="label" style="margin-right:8px;white-space:nowrap">2 selected</span>' + "".join(f'<button class="mt-btn" data-variant="ghost" data-size="sm" style="color:var(--text-inverse)">{icon(i)}{l}<span class="mt-kbd">{k}</span></button>' for i, l, k in [("check", "Mark read", "E"), ("clock", "Snooze", "H"), ("archive", "Archive", "Y")]) + "</div>")
    lst = f'<div style="flex:1;min-width:0;position:relative;display:flex;flex-direction:column;border-right:1px solid var(--border-default)">{toolbar}<div role="list" style="flex:1">{rows}</div>{bulk}</div>'
    detail = ('<div class="mt-col" style="width:380px;flex:none;gap:14px;padding:20px">'
              + '<div class="mt-row" style="gap:8px">' + status("active", .25) + '<span class="mono-s t-3">WE-142</span>' + tag("probate") + '<span class="mt-ml">' + btn("Open matter", "ghost", "sm", trail="arrow-right") + "</span></div>"
              + '<div class="title-m">Estate of Margaret Whitfield</div>'
              + '<div class="mt-col" style="gap:12px;padding:12px;border-radius:10px;background:var(--bg-canvas)">'
              + '<div class="mt-row" style="gap:8px">' + avatar("PS", "sm", hue="2") + '<span class="label">Priya Shah</span><span class="caption t-3">9:14 am · on Asset schedule</span></div>'
              + '<p class="body" style="margin:0"><span class="t-brand">@Jordan</span> can you check the asset schedule before I send it to Peter Hale? The Westpac balance is from August.</p>'
              + '<div class="mt-row" style="gap:8px;padding:8px 10px;border-radius:8px;background:var(--bg-surface);border:1px solid var(--border-default)">' + icon("document", None, "t-3") + '<span class="label mt-grow mt-ell">Asset schedule v3.xlsx</span><span class="caption t-3">Documents</span></div></div>'
              + '<div class="mt-composer" style="box-shadow:none;border-color:var(--border-control)"><div class="field">Reply to Priya…</div><div class="bar">' + ibtn("at-sign", "Mention", size="sm") + ibtn("attach", "Attach", size="sm") + '<span class="mt-grow"></span>' + btn("Reply", "primary", "sm") + "</div></div>"
              + '<div class="mt-row" style="gap:6px">' + btn("Mark read", "secondary", "sm", "check", ["E"]) + btn("Snooze", "ghost", "sm", "clock", ["H"]) + "</div>"
              + '<p class="caption t-3" style="margin:0">J and K move through the list. Enter opens the item; X selects it.</p></div>')
    page = f'<div style="display:flex;flex:1;min-height:0">{lst}{detail}</div>'
    return frame("inbox", ["Inbox"], inbox_seg(0) + btn("Mark all read", "ghost", "sm", "check-check") + ibtn("settings", "Notification settings", size="sm"), page)


# ------------------------------------------------------------------ Inbox: unfiled email (INT-05)
def unfiled():
    mails = [("CW", None, "Catherine Whitfield", "Re: Mum’s Westpac and CBA statements", "3 attachments · 9:02 am", ("probate", "WE-142", "Whitfield", "High"), True),
             ("KH", "2", "Kevin Ho (Ho Legal)", "Nguyen v Nguyen: proposed consent orders", "1 attachment · 8:37 am", ("fp", "WE-097", "Nguyen v Nguyen", "High"), False),
             ("SL", "3", "Sarah Lin", "Referral: new will client, Mr and Mrs Tran", "Yesterday", None, False),
             ("NB", "4", "Geelong Council Rates", "Rates notice 22 Kite St, Ocean Grove", "Yesterday · 1 attachment", ("probate", "WE-160", "Lambert", "Medium"), False),
             ("AU", None, "noreply@ato.example.gov.au", "Your agent portal: new message", "Wed 30 Sep", None, False)]
    rows = []
    for a, h, frm, subj, meta, sug, sel in mails:
        if sug:
            t, ref, nm, conf = sug
            s = f'<span class="mt-row" style="gap:6px">{icon("sparkle", "sm", "t-ai")}{tag(t, ref)}<span class="mt-ell t-2">{nm}</span>{badge(conf, "ai" if conf == "High" else None)}</span>'
            act = btn(f"File to {ref}", "ai", "sm")
        else:
            s = '<span class="caption t-3">No likely matter</span>'
            act = btn("Choose matter", "secondary", "sm")
        rows.append(f'<tr{" data-selected" if sel else ""}><td style="max-width:0;width:46%"><div class="mt-row" style="gap:10px">{avatar(a, hue=h)}<div class="mt-grow"><div class="title mt-ell">{subj}</div><div class="caption t-3 mt-ell">{frm} · {meta}</div></div></div></td>'
                    f'<td style="max-width:0;width:30%">{s}</td><td style="text-align:right;padding-right:12px"><span class="mt-row" style="gap:4px;justify-content:flex-end">{act}{ibtn("more", "More", size="sm")}</span></td></tr>')
    table = ('<div style="flex:1;min-width:0;border-right:1px solid var(--border-default)"><div class="mt-row" style="padding:10px 16px;border-bottom:1px solid var(--border-default);gap:6px">' + chip("Waiting 5", selected=True) + chip("Filed today 14") + chip("Not matter mail 3")
             + '<span class="mt-ml caption t-3">Mail to file@haleprice.in.materia.example that didn’t name a matter</span></div>'
             + '<table class="mt-table"><thead><tr><th>Email</th><th>Clerk suggests</th><th></th></tr></thead><tbody>' + "".join(rows) + "</tbody></table></div>")
    preview = ('<div class="mt-col" style="width:380px;flex:none;gap:14px;padding:20px">'
               + '<div class="mt-col" style="gap:4px"><span class="title-m">Re: Mum’s Westpac and CBA statements</span><span class="caption t-3">Catherine Whitfield &lt;cwhitfield@example.com.au&gt; · 9:02 am</span></div>'
               + '<p class="body t-2" style="margin:0">Hi Jordan, attached are the Westpac and CBA statements from Mum’s files. I’ll bring the original share certificates on Friday. Catherine</p>'
               + '<div class="mt-col" style="gap:6px">' + "".join(f'<div class="mt-row" style="gap:8px;padding:6px 10px;border-radius:8px;border:1px solid var(--border-default)">{icon("document", None, "t-3")}<span class="label mt-grow mt-ell">{n}</span><span class="caption t-3">{s}</span></div>' for n, s in [("Westpac_statement_Sep.pdf", "4 pages"), ("CBA_statement_Sep.pdf", "3 pages"), ("Share_registry_letter.pdf", "1 page")]) + "</div>"
               + '<div class="mt-suggestion" style="flex-direction:column;align-items:stretch"><div class="mt-row" style="gap:8px">' + avatar(kind="clerk", size="sm") + '<span class="tt mt-grow">File to <b>WE-142 · Estate of Margaret Whitfield</b></span></div>'
               + '<ul class="body-s t-2" style="margin:0;padding-left:18px"><li>Catherine Whitfield is the executor on WE-142.</li><li>The statements are for accounts in the asset schedule.</li></ul>'
               + '<div class="mt-cites">' + cite("Parties · WE-142", 1) + cite("Asset schedule v3 · rows 4–5", 2) + '</div><div class="mt-row" style="gap:6px">' + btn("Not this matter", "ghost", "sm") + '<span class="mt-ml">' + btn("File email and 3 attachments", "ai", "sm", "check") + "</span></div></div>"
               + FOOT + "</div>")
    page = f'<div style="display:flex;flex:1;min-height:0">{table}{preview}</div>'
    return frame("inbox", ["Inbox", "Unfiled email"], inbox_seg(1) + btn("File all high-confidence", "ai", "sm", "sparkle"), page)


# ------------------------------------------------------------------ Notifications popover
def notifications():
    pop = ('<div class="mt-menu" role="dialog" aria-label="Notifications" style="position:absolute;top:52px;right:20px;width:400px;padding:0;overflow:hidden;z-index:5">'
           + '<div class="mt-row" style="height:44px;padding:0 8px 0 16px;border-bottom:1px solid var(--border-default)"><span class="label mt-grow">Notifications</span>' + btn("Mark all read", "ghost", "sm", "check-check") + ibtn("settings", "Notification settings", size="sm") + "</div>"
           + '<div role="list">'
           + notif("mention", "<b>Priya Shah</b> mentioned you on <b>WE-142</b>", "“@Jordan can you check the asset schedule…”", "9:14 am", True)
           + notif("overdue", "<b>Serve plaintiff’s affidavit</b> is 2 days overdue", "WE-097 · Nguyen v Nguyen", "8:00 am", True)
           + notif("deadline", "<b>Publish notice</b> is due today", "WE-142 · Whitfield", "7:30 am", True)
           + notif("clerk", "<b>Clerk</b> drafted 6 time entries", "2.1 h to review", "7:02 am") + "</div>"
           + '<div class="mt-row" style="padding:8px 12px;border-top:1px solid var(--border-default)"><span class="caption t-3 mt-grow">Showing the latest 4 of 10</span>' + btn("Open Inbox", "ghost", "sm", trail="arrow-right") + "</div></div>")
    page = matters_list(pop)
    # The bell carries the unread count while the popover is open.
    return page.replace('aria-label="Notifications" title="Notifications"', 'aria-label="Notifications, 3 unread" title="Notifications" data-active style="background:var(--bg-pressed)"', 1)


# ------------------------------------------------------------------ Clerk full page (AI-14)
def clerk_page():
    def thread(t, sub, active=False, shared=False):
        a = "background:var(--bg-selected);" if active else ""
        sh = badge("Shared", None, "contacts") if shared else ""
        return f'<a class="mt-col" href="#" onclick="return false" style="gap:2px;padding:8px 10px;border-radius:6px;text-decoration:none;color:inherit;{a}"><div class="mt-row" style="gap:6px"><span class="label mt-ell mt-grow">{t}</span>{sh}</div><span class="caption t-3 mt-ell">{sub}</span></a>'

    threads = ('<div class="mt-col" style="width:288px;flex:none;gap:4px;padding:12px;border-right:1px solid var(--border-default)">'
               + '<div class="mt-row" style="gap:6px"><span class="mt-input mt-grow" data-size="sm">' + icon("search") + '<span class="v ph">Search threads</span></span>' + ibtn("compose", "New thread", "secondary", "sm") + "</div>"
               + '<div class="mt-nav-section">General</div>'
               + thread("Notice periods for intestate estates", "Practice question · Fri") + thread("Uniform Law costs disclosure threshold", "Practice question · 28 Sep")
               + '<div class="mt-nav-section">Matters</div>'
               + thread("When can the executors distribute?", "WE-142 · Whitfield · 9:20 am", True) + thread("Family provision risk", "WE-142 · Whitfield · Thu")
               + thread("Gaps in Lan’s affidavit", "WE-097 · Nguyen v Nguyen · Wed") + thread("Expert evidence timetable", "WE-171 · Doyle v Brennan · 1 Oct", shared=True)
               + '<div class="mt-card" data-pad style="margin-top:auto;box-shadow:none;gap:8px"><div class="mt-row"><span class="label mt-grow">October usage</span>' + badge("Admins", None, "shield") + "</div>"
               + '<div class="mt-meter"><i style="width:25%"></i><b style="left:80%"></b></div><div class="mt-row caption t-3"><span class="mono t-1">$38.20</span><span>of $150 budget</span><span class="mt-ml">412 questions</span></div>'
               + '<span class="caption t-3">The firm’s own Anthropic key · Sonnet 5.5. Tick marks the 80% alert.</span></div></div>')
    answer = ('<div class="mt-msg" data-role="clerk">' + avatar(kind="clerk", size="sm") + '<div class="body">'
              + '<p><b>Not before 6 months after the grant, and only once the statutory notice has expired.</b> Whitfield has no grant yet, so there is no distribution date to diarise.<sup>1</sup></p>'
              + '<ul><li>Distributing after 6 months from the grant, with no notice of a family provision claim, protects the executors (s 99A).<sup>2</sup></li>'
              + '<li>The s 33 notice to creditors and claimants must also have expired. It hasn’t been published.<sup>3</sup></li>'
              + '<li>Thomas Whitfield is a likely claimant, and the file note of 14 Aug suggests he is thinking about it.<sup>4</sup></li></ul>'
              + '<p>If the grant issues in mid-November, the earliest safe date is mid-May 2027.</p>'
              + '<div class="mt-cites">' + cite("Deadlines · WE-142", 1) + cite("APA 1958 (Vic) s 99A", 2) + cite("APA 1958 (Vic) s 33", 3) + cite("File note 14 Aug", 4) + "</div>"
              + '<div class="mt-row" style="gap:6px">' + btn("Add s 33 notice task", "secondary", "sm", "plus") + btn("Draft advice to executors", "ai", "sm", "sparkle") + "</div>" + FOOT + "</div></div>")
    convo = ('<div style="flex:1;min-width:0;display:flex;flex-direction:column">'
             + '<div class="mt-row" style="height:48px;padding:0 12px 0 20px;border-bottom:1px solid var(--border-default);gap:8px"><span class="label mt-ell">When can the executors distribute?</span><span class="mt-ml mt-row" style="gap:4px">' + btn("Share", "ghost", "sm", "user-plus") + ibtn("more", "More", size="sm") + "</span></div>"
             + '<div class="mt-col" style="flex:1;gap:20px;padding:24px 28px;max-width:760px;width:100%;margin:0 auto">'
             + '<div class="mt-msg" data-role="user">When can the executors safely distribute the Whitfield estate?</div>' + answer + "</div>"
             + '<div style="padding:0 28px 20px;max-width:760px;width:100%;margin:0 auto"><div class="mt-composer"><span class="ctx">' + icon("matters") + "WE-142 · Whitfield" + icon("x") + '</span><div class="field">Ask a follow-up…</div><div class="bar">' + ibtn("attach", "Attach", size="sm") + ibtn("mic", "Dictate", size="sm") + '<span class="mt-grow"></span><span class="mt-composer-hint">' + kbd("↵") + 'to send</span><button class="mt-send" aria-label="Send">' + icon("send") + "</button></div></div></div></div>")
    srcs = [("1", "Deadlines · WE-142", "Family provision window ends · blocked: no grant yet", None), ("2", "APA 1958 (Vic) s 99A", "“…a personal representative who distributes … after the expiry of 6 months from the grant … is not liable…”", "Statute"),
            ("3", "APA 1958 (Vic) s 33", "Notice to creditors and others · a claims period of at least 60 days", "Statute"), ("4", "File note 14 Aug", "“Thomas asked Catherine for a copy of the will and said he’d ‘see someone about it’.”", "Privileged")]
    sources = ('<div class="mt-col" style="width:320px;flex:none;gap:10px;padding:12px 16px;border-left:1px solid var(--border-default);background:var(--bg-canvas)">'
               + '<div class="mt-row" style="height:24px"><span class="label mt-grow">Sources</span><span class="mt-count">4</span></div>'
               + "".join(f'<div class="mt-card" data-pad style="gap:6px;padding:12px{";border-color:var(--border-ai)" if n == "2" else ""}"><div class="mt-row" style="gap:6px"><span class="mt-cite"><span class="n">{n}</span></span><span class="label mt-ell mt-grow">{t}</span>{badge(b, "warning" if b == "Privileged" else None) if b else ""}</div><p class="body-s t-2" style="margin:0">{q}</p><span class="caption t-brand">Open {icon("arrow-up-right", "sm")}</span></div>' for n, t, q, b in srcs)
               + '<p class="caption t-3" style="margin:0">Privileged sources stay inside the firm. Sharing this thread shares the answer, not the file note.</p></div>')
    page = f'<div style="display:flex;flex:1;min-height:0">{threads}{convo}{sources}</div>'
    return frame("clerk", ["Clerk"], btn("New thread", "ai", "sm", "sparkle", ["⌘", "J"]), page)


# ------------------------------------------------------------------ Tablet
def rail(active):
    items = [("today", "Today", "today"), ("inbox", "Inbox", "inbox"), None, ("matters", "Matters", "matters"), ("deadlines", "Deadlines", "calendar"), ("billing", "Time and billing", "billing"),
             ("insights", "Insights", "insights"), ("disputes", "Disputes", "court"), ("contacts", "Contacts", "contacts")]
    out = ['<aside class="mt-sidebar">', '<div class="mt-ws" style="padding:0;justify-content:center" title="Hale &amp; Price">' + avatar("HP", "sm", kind="org") + "</div>", ibtn("sidebar", "Expand sidebar", size="sm")]
    for it in items:
        if it is None:
            out.append('<div class="mt-nav-section">Workspace</div>')
            continue
        k, l, i = it
        a = " data-active" if k == active else ""
        out.append(f'<a class="mt-nav" href="#" onclick="return false"{a} aria-label="{l}" title="{l}">{icon(i)}</a>')
    out.append('<div style="margin-top:auto;display:flex;flex-direction:column;align-items:center;gap:6px">' + ibtn("sparkle", "Ask Clerk (⌘J)", "ai") + avatar("JP", "sm") + "</div></aside>")
    return "".join(out)


def tablet(active, crumbs, actions, page, w=1024, h=768):
    top = f'<div class="mt-topbar"><nav class="mt-crumbs" aria-label="Breadcrumb">{"".join(("" if i == 0 else icon("chevron-right")) + f"<span>{c}</span>" for i, c in enumerate(crumbs))}</nav><div class="mt-ml mt-row" style="gap:6px">{actions}{ibtn("bell", "Notifications", size="sm")}</div></div>'
    return (f'<div data-frame style="width:{w}px;height:{h}px;flex:none;border-radius:28px;overflow:hidden;box-shadow:0 0 0 1px var(--border-default),0 0 0 12px var(--slate-900),var(--shadow-dialog)">'
            f'<div class="mt-app" data-collapsed style="height:100%">{rail(active)}<main class="mt-main" style="min-height:0">{top}<div class="mt-page" style="overflow:hidden;padding:20px 24px">{page}</div></main></div></div>')


def tablet_stage(device, title, rules):
    notes = ('<div class="mt-col" style="gap:12px;width:300px;flex:none;padding-top:8px"><span class="eyebrow t-3">Tablet · 768–1199px</span><span class="title-m">' + title + '</span><ul class="body-s t-2" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px">'
             + "".join(f"<li>{r}</li>" for r in rules) + "</ul></div>")
    return f'<div class="mt" style="width:1440px;min-height:900px;display:flex;justify-content:center;align-items:flex-start;gap:56px;padding:64px 40px;background:var(--bg-canvas)">{device}{notes}</div>'


RAIL_RULES = ["The sidebar collapses to a 56px rail of icons with tooltips; the rail button or <code>[</code> expands it over the page.", "Pinned matters and section labels hide in the rail; ⌘K reaches everything.", "Targets stay at least 36px; touch screens get 44px rows."]


def tablet_today():
    brief = ('<div class="mt-clerk-card"><div class="in" style="gap:8px"><div class="mt-clerk-head">' + avatar(kind="clerk", size="sm") + 'Morning brief · 7:42 am<span class="mt-ml">' + btn("Ask a follow-up", "ai", "sm", "sparkle") + "</span></div>"
             + "".join(f'<div class="mt-row" style="align-items:flex-start;gap:10px;padding:10px 0;border-top:1px solid var(--border-subtle)">{icon(ic, None, "t-" + tn)}<div class="mt-grow body-s t-2"><b class="t-1">{m}</b> {t}</div>{btn(a, "secondary", "sm")}</div>' for ic, tn, m, t, a in [
                 ("alert", "danger", "Nguyen v Nguyen.", "Affidavit service is 2 days late. I’ve drafted a consent-extension letter.", "Review"), ("court", "brand", "Whitfield.", "Publish the probate notice today; the application can be filed from 16 Oct.", "Open"), ("draft", "warning", "Okafor.", "Thursday’s will signing still needs a second witness.", "Add task")])
             + "</div></div>")
    tasks = ('<div class="mt-card" data-pad>' + section_h('My tasks <span class="mt-count">6</span>', btn("New task", "ghost", "sm", "plus")) + '<div class="mt-col" style="gap:2px;margin:0 -8px">'
             + task("Send estate asset questionnaire to executors", "WE-142 · Whitfield", deadline("Today", "today")) + task("Search for next of kin", "WE-133 · Fairweather", deadline("Mon 12 Oct", "upcoming"))
             + task("Book will signing room for Thursday", "WE-151 · Okafor", deadline("Thu 8 Oct", "soon")) + "</div></div>")
    right = ('<div class="mt-col" style="gap:12px">' + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' + stat("Billable this week", "18.4", "of 25 h", " h") + stat("Deadlines in Oct", "9", '<span class="t-danger">1 overdue</span>') + "</div>"
             + '<div class="mt-card" data-pad>' + section_h("This week") + '<div class="mt-timeline">' + tl("overdue", "Serve plaintiff’s affidavit", "Nguyen v Nguyen", deadline("Overdue 2d", "overdue")) + tl("next", "Publish notice", "Whitfield · A&amp;P Rules 2014", deadline("Today", "today")) + tl("upcoming", "Will signing", "Okafor · 10:00 am", deadline("Thu 8 Oct", "soon"), "draft") + "</div></div></div>")
    page = ('<div class="mt-col" style="gap:4px"><span class="eyebrow t-3">Monday 5 October</span><h1 class="title-l" style="margin:0">Good morning, Jordan</h1></div>'
            f'<div style="display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start"><div class="mt-col" style="gap:16px">{brief}{tasks}</div>{right}</div>')
    dev = tablet("today", ["Today"], btn("Record time", "secondary", "sm", "timer") + btn("New matter", "primary", "sm", "plus"), page)
    return tablet_stage(dev, "Today, landscape 1024 × 768", RAIL_RULES + ["The right column narrows to 340px; numbers drop to two tiles and Time to review moves below the fold.", "The greeting drops from display to title size."])


def tablet_matter():
    stages = ["Intake", "Will & assets", "Notice", "Filed", "Grant", "Collect", "Debts & tax", "Distribute", "Finalise"]
    page = ('<div class="mt-col" style="gap:10px"><div class="mt-row" style="gap:8px">' + status("active", .25) + '<span class="mono-s t-3">WE-142</span>' + tag("probate") + badge("Notice period", "brand") + '<span class="caption t-3">Supreme Court of Victoria</span></div>'
            + '<h1 class="title-l" style="margin:0">Estate of Margaret Whitfield</h1>'
            + '<ol class="mt-stepper">' + "".join(f'<li data-state="{"done" if i < 2 else "current" if i == 2 else ""}">{s}</li>' for i, s in enumerate(stages)) + "</ol></div>"
            + '<div class="mt-tabs" style="overflow:hidden">' + "".join(f'<button class="mt-tab"{" data-active" if i == 0 else ""}>{t}</button>' for i, t in enumerate(["Overview", "Deadlines", "Estate", "Parties", "Documents", "Time", "Activity"])) + "</div>"
            + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">'
            + '<div class="mt-card" data-pad>' + section_h("Key facts", btn("Edit", "ghost", "sm")) + '<dl class="mt-facts"><dt>Date of death</dt><dd>22 Jul 2026 · aged 81</dd><dt>Last address</dt><dd>14 Ashby St, Newtown VIC 3220</dd><dt>Executors</dt><dd>Catherine Whitfield, Peter Hale</dd><dt>Fee</dt><dd>Hourly · $440</dd></dl></div>'
            + '<div class="mt-card" data-pad>' + section_h("Statutory deadlines") + '<div class="mt-timeline">' + tl("done", "Caveat search: none lodged", "RedCrest · 1 Oct", deadline("Done", "done")) + tl("next", "Publish notice", "<code>A&amp;P Rules 2014</code>", deadline("Today", "today")) + tl("upcoming", "Family provision window ends", "<code>APA 1958 (Vic) s 99</code>", badge("No grant yet"), "scale") + "</div></div>"
            + "</div>")
    clerk_btn = ('<div style="position:absolute;right:20px;bottom:20px">' + btn("Ask Clerk about this estate", "ai", None, "sparkle", ["⌘", "J"]).replace('class="mt-btn"', 'class="mt-btn" style="box-shadow:var(--shadow-popover)"') + "</div>")
    dev = tablet("matters", ["Matters", "WE-142"], btn("Record time", "secondary", "sm", "timer") + btn("Publish notice", "primary", "sm", "court"), page + clerk_btn)
    dev = dev.replace('<div class="mt-page" style="overflow:hidden;padding:20px 24px">', '<div class="mt-page" style="overflow:hidden;padding:20px 24px;position:relative">', 1)
    return tablet_stage(dev, "Matter, landscape 1024 × 768", RAIL_RULES[:1] + ["Clerk doesn’t sit beside the matter: it opens as a 400px sheet over the right side, and closes with Esc.", "Tabs scroll sideways when they don’t fit; the stepper keeps every stage label.", "Cards stay two-up down to 900px wide, then stack."])


def tablet_list():
    rows = []
    for _, ref, name, t, stt, stage, dl_, (who, hue), wip, pr, flag in MATTERS[:8]:
        dlh = deadline(*dl_) if dl_ else '<span class="caption t-3">Building</span>'
        rows.append(f'<tr><td style="width:22px;padding:0 4px 0 12px">{priority(pr)}</td><td style="max-width:0;width:60%"><div class="mt-row" style="gap:8px">{status(*stt)}<div class="mt-grow"><div class="title mt-ell">{name}</div><div class="caption t-3 mt-ell"><span class="mono-s">{ref}</span> · {stage}</div></div></div></td><td>{dlh}</td><td style="padding-right:16px">{avatar(who, hue=hue)}</td></tr>')
    page = ('<div class="mt-row mt-wrap" style="gap:6px">' + chip("Mine 18", "user", True) + chip("All matters") + chip("Filter", "plus", filt=True) + "</div>"
            + '<div class="mt-card" style="overflow:hidden"><table class="mt-table"><thead><tr><th></th><th>Matter</th><th>Next deadline</th><th></th></tr></thead><tbody>' + "".join(rows) + "</tbody></table></div>")
    actions = '<div class="mt-seg"><button class="mt-seg-item" data-selected aria-label="List">' + icon("list") + '</button><button class="mt-seg-item" aria-label="Board">' + icon("board") + "</button></div>" + btn("New matter", "primary", "sm", "plus")
    dev = tablet("matters", ["Matters"], actions, page, 768, 1024)
    return tablet_stage(dev, "Matters list, portrait 768 × 1024", RAIL_RULES[:1] + ["The table keeps priority, the matter (with ref and stage underneath), the next deadline and the owner. Type, WIP and selection move into the row’s menu.", "View switcher buttons lose their labels; the plain-English filter moves into ⌘K.", "Board view scrolls sideways a column at a time."])


# ------------------------------------------------------------------ System states
def mini(title, body, actions="", top=""):
    head = f'<div class="mt-topbar" style="height:44px"><nav class="mt-crumbs"><span aria-current="page">{title}</span></nav><div class="mt-ml mt-row" style="gap:6px">{actions}</div></div>'
    return f'<div class="mt-main" data-frame style="margin:0;height:340px;position:relative">{head}{top}<div style="flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column">{body}</div></div>'


def labelled(n, title, desc, panel):
    return f'<div class="mt-col" style="gap:10px;min-width:0"><div class="mt-col" style="gap:2px"><span class="label"><span class="mono-s t-3">{n}</span> {title}</span><span class="caption t-3">{desc}</span></div>{panel}</div>'


def system_states():
    def trow(cells):
        return f'<div class="mt-row" style="gap:12px;height:40px;padding:0 16px;border-bottom:1px solid var(--border-subtle)">{cells}</div>'

    loading = mini("Matters", '<div class="mt-loading-bar" data-active><i></i></div><div aria-busy="true"><span class="mt-sr">Loading matters</span>'
                   + "".join(trow(skel("14px", 14, "circle") + skel("40px") + skel(w) + f'<span class="mt-ml mt-row" style="gap:12px">{skel("72px", shape="chip")}{skel("24px", 24, "circle")}</span>') for w in ("46%", "34%", "52%", "28%", "40%", "36%")) + "</div>",
                   btn("New matter", "primary", "sm", "plus"))
    empty = mini("Inbox", '<div class="mt-row" style="padding:10px 16px;gap:6px;border-bottom:1px solid var(--border-default)">' + chip("All", selected=True) + chip("Mentions") + chip("Deadlines") + chip("Clerk") + "</div>"
                 + '<div class="mt-empty" style="flex:1;justify-content:center;padding:24px"><span class="glyph">' + icon("check-check") + '</span><h3>You’re all caught up</h3><p>New mentions, assignments, deadlines and finished Clerk work land here.</p><div class="mt-row">' + btn("Notification settings", "secondary", "sm", "settings") + "</div></div>",
                 inbox_seg(0))
    error = mini("Deadlines", '<div class="mt-empty" style="flex:1;justify-content:center;padding:24px"><span class="glyph" style="background:var(--bg-danger-subtle);color:var(--text-danger)">' + icon("alert") + '</span><h3>Couldn’t load deadlines</h3><p>The server didn’t answer. Your deadlines are safe; this is a problem fetching them.</p><div class="mt-row">' + btn("Try again", "secondary", "sm", "refresh") + '</div><span class="caption t-3">Reference <span class="mono">DL-7F3A</span> if you contact support</span></div>',
                 btn("Add deadline", "primary", "sm", "plus"))
    offline = mini("Contacts", '<div class="mt-col" style="gap:1px;padding:8px">' + "".join(f'<div class="mt-row" style="gap:10px;padding:8px 12px">{avatar(a, hue=h)}<div class="mt-grow"><div class="label mt-ell">{n}</div><div class="caption t-3 mt-ell">{r}</div></div></div>' for a, h, n, r in [("CW", None, "Catherine Whitfield", "Executor · WE-142"), ("PH", "2", "Peter Hale", "Executor · referrer"), ("TW", "risk", "Thomas Whitfield", "Son of the deceased"), ("KH", "3", "Kevin Ho", "Opposing solicitor · Ho Legal")]) + "</div>",
                   btn("New contact", "primary", "sm", "plus"), banner("<b>You’re offline.</b> Showing contacts from 9:41 am. Changes save here and sync when you reconnect.", "warning", "wifi-off", btn("Retry", "ghost", "sm", "refresh")))
    noaccess = mini("Matters › WE-097", '<div class="mt-empty" style="flex:1;justify-content:center;padding:24px"><span class="glyph">' + icon("lock") + '</span><h3>This matter is restricted</h3><p>Nguyen v Nguyen is open only to Daniel Kim and Priya Shah. Ask either of them, or an owner or admin, to add you.</p><div class="mt-row">' + btn("Request access", "secondary", "sm", "user-plus") + btn("Back to matters", "ghost", "sm") + "</div></div>")
    ro_rows = "".join(trow(f'{priority(pr)}<span class="mono-s t-3" style="width:48px">{ref}</span>{status(*stt)}<span class="label mt-ell mt-grow">{name}</span>{deadline(*dl_) if dl_ else ""}{avatar(who, hue=hue)}') for _, ref, name, t, stt, stage, dl_, (who, hue), wip, pr, flag in MATTERS[2:7])
    readonly = mini("Matters", ro_rows, btn("Export", "ghost", "sm", "upload"), banner("<b>Read-only access.</b> You can view matters and documents. New matter, bulk actions and editing are hidden.", None, "eye"))
    grid = ('<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px 24px">'
            + labelled("01", "Loading", "Skeleton rows in the real layout. Refreshes keep the old rows.", loading)
            + labelled("02", "Empty", "What the list is for and the one action that fills it.", empty)
            + labelled("03", "Error with retry", "What failed, that nothing is lost, Try again, and a reference.", error)
            + labelled("04", "Offline", "A warning Banner; cached rows stay readable, with their time.", offline)
            + labelled("05", "No access", "Says who can open it and how to ask. Never a bare 403.", noaccess)
            + labelled("06", "Read-only role", "An info Banner; create, bulk and edit controls are hidden, not disabled.", readonly) + "</div>")
    copy = [("Matters", "No matters yet", "Create a matter, or drop a will and death certificate and Clerk builds one.", "New matter"), ("Deadlines", "No deadlines this week", "Deadlines appear when a matter’s type, jurisdiction and key dates are set.", "Add deadline"),
            ("Tasks", "Nothing assigned to you", "Tasks you own or are assigned show here, soonest first.", "New task"), ("Time and billing", "No time recorded today", "Press T anywhere to record time, or review what Clerk captured.", "Record time"),
            ("Contacts", "No contacts yet", "People are added from matters, intake and email, or by hand.", "New contact"), ("Documents", "No documents on this matter", "Drop files here or forward email to the matter’s address.", "Upload"),
            ("Inbox", "You’re all caught up", "New mentions, assignments, deadlines and Clerk work land here.", "Notification settings"), ("Unfiled email", "No unfiled email", "Mail to the firm’s filing address that names no matter waits here.", "Copy filing address"),
            ("Team and roles", "Just you so far", "Invite the people you work with and choose their roles.", "Invite people"), ("Audit log", "No entries match these filters", "Widen the dates or clear a filter.", "Clear filters"),
            ("Clerk threads", "No threads yet", "Ask about a matter, or a general practice question.", "New thread")]
    ctable = card("Empty state copy for every list", '<div style="margin:0 -16px"><table class="mt-table" style="table-layout:fixed"><thead><tr><th style="width:150px">List</th><th style="width:230px">Heading</th><th>Line</th><th style="width:190px">Action</th></tr></thead><tbody>'
                  + "".join(f'<tr><td class="title">{l}</td><td>{h}</td><td class="t-2" style="white-space:normal;padding-top:8px;padding-bottom:8px">{s}</td><td>{badge(a)}</td></tr>' for l, h, s, a in copy) + "</tbody></table></div>"
                  + '<p class="caption t-3" style="margin:0">Filtered lists that come back empty say so and offer Clear filters instead. Errors and offline use the same pattern on every list.</p>')
    return f'<div class="mt" style="width:1440px;min-height:900px;display:flex;flex-direction:column;gap:32px;padding:48px 56px;background:var(--bg-canvas)">{grid}{ctable}</div>'


SCREENS = [
    ("Inbox", "Notifications grouped by day, filtered by mentions, assignments, deadlines and Clerk, with selection, bulk mark read, snooze and archive, and a reply pane.", inbox),
    ("Inbox: unfiled email", "Mail to the firm’s filing address that named no matter (INT-05): Clerk suggests a matter with reasons and citations; a person files it.", unfiled),
    ("Notifications", "The bell’s popover over the matters list: the latest unread items, mark all read and a way into the Inbox.", notifications),
    ("Clerk", "Clerk full page (AI-14): threads by matter and general, shared threads, the conversation, its sources (privileged ones flagged) and an admin usage meter.", clerk_page),
    ("Tablet: Today", "Today at 1024 × 768 with the sidebar collapsed to a rail.", tablet_today),
    ("Tablet: Matter", "A matter at 1024 × 768: Clerk opens as a sheet, tabs scroll, cards stay two-up.", tablet_matter),
    ("Tablet: Matters list", "The matters list at 768 × 1024 portrait, with columns folded into the matter cell.", tablet_list),
    ("System states", "Loading, empty, error with retry, offline, no access and read-only, plus the empty-state copy for every list.", system_states),
]
