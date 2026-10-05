"""Fourth-pass screens (DES-01): the Settings sub-pages. Composed from catalogue components only."""
from components_pass4 import banner, integration, skel
from icons import icon
from markup import *
from screens import frame, section_h
from screens_next import card, chip, select_sm, setting, settings_sidebar

LONG_FIRM = "Hale &amp; Price Wills, Estates and Succession Lawyers of Geelong and the Bellarine Pty Ltd"


def sec(h, p, rows, right=""):
    head = f'<div class="mt-row" style="align-items:flex-end"><h3 style="margin:0 0 4px;font:600 14px/20px var(--font-sans)">{h}</h3><span class="mt-ml">{right}</span></div>' if right else f"<h3>{h}</h3>"
    return f'<div class="mt-settings-section">{head}<p>{p}</p>{"".join(rows)}</div>'


def page_head(title, lead, right=""):
    return (f'<div class="mt-row" style="align-items:flex-start;gap:16px"><div class="mt-col mt-grow" style="gap:6px"><h1 class="title-l" style="margin:0">{title}</h1>'
            f'<p class="body t-2" style="margin:0;max-width:640px">{lead}</p></div>{right}</div>')


def inp(v, w=220, suffix=None, ic=None, mono=False):
    s = f'<span class="suffix">{suffix}</span>' if suffix else ""
    i = icon(ic) if ic else ""
    m = ' style="font-family:var(--font-mono)"' if mono else ""
    return f'<span class="mt-input" data-size="sm" style="width:{w}px">{i}<span class="v mt-ell"{m}>{v}</span>{s}</span>'


def save_bar(msg="2 unsaved changes"):
    return (f'<div class="mt-row" style="position:sticky;bottom:0;padding:10px 12px 10px 16px;border-radius:10px;background:var(--bg-inverse);color:var(--text-inverse);box-shadow:var(--shadow-dialog)">'
            f'<span class="label mt-grow">{msg}</span><button class="mt-btn" data-variant="ghost" data-size="sm" style="color:var(--text-inverse)">Discard</button>{btn("Save changes", "primary", "sm")}</div>')


def settings_frame(active, page, actions=""):
    return frame("settings", ["Settings", active], actions, f'<div class="mt-page">{page}</div>', side=settings_sidebar(active))


# ------------------------------------------------------------------ Team and roles
MEMBERS = [("JP", None, "Jordan Price", "jordan.price@haleprice.example.com.au", "Owner", "on", "Now", "active"),
           ("PS", "2", "Priya Shah", "priya.shah@haleprice.example.com.au", "Lawyer", "on", "12 min ago", "active"),
           ("AK", "4", "Alexandra Konstantinidou-Fitzwilliam", "alexandra.konstantinidou-fitzwilliam@haleprice.example.com.au", "Lawyer", "on", "Yesterday", "active"),
           ("DK", "3", "Daniel Kim", "daniel.kim@haleprice.example.com.au", "Admin", "on", "2 h ago", "active"),
           ("MT", "4", "Mia Torres", "mia.torres@haleprice.example.com.au", "Paralegal", "off", "Fri 2 Oct", "active"),
           ("LN", "2", "Lan Nguyen", "lan.nguyen@haleprice.example.com.au", "Paralegal", "off", "Thu 1 Oct", "active"),
           ("RB", "3", "Rhys Bennett", "rhys.bennett@haleprice.example.com.au", "Read-only", "on", "28 Sep", "active"),
           ("SO", None, "Sam O’Connell", "sam.oconnell@haleprice.example.com.au", "Lawyer", "on", "14 Aug", "suspended")]
ROLE_MATRIX = [("See matters, documents and deadlines", "yyyyy"), ("Create and edit matters, tasks and notes", "yyyy-"), ("Record time", "yyyy-"),
               ("See privileged documents", "yyy--"), ("Approve invoices", "yyy--"), ("Change rates, practice and Clerk settings", "yy---"), ("Invite, suspend and remove people", "yy---"),
               ("Transfer ownership or close the firm", "y----")]


def team():
    def mfa(state):
        return badge("On", "success") if state == "on" else badge("Not set up", "warning")

    rows = []
    for a, h, n, e, role, m, last, st in MEMBERS:
        sus = st == "suspended"
        role_c = '<span class="body-s t-2">Owner</span>' if role == "Owner" else select_sm(role).replace("width:220px", "width:132px")
        status_c = badge("Suspended") if sus else ""
        act = btn("Reactivate", "ghost", "sm") if sus else ibtn("more", f"More actions for {n}", size="sm")
        dim = ' style="opacity:.64"' if sus else ""
        rows.append(f'<tr><td style="max-width:0;width:44%"><div class="mt-row" style="gap:10px"{dim}>{avatar(a, hue=h)}<div class="mt-grow"><div class="title mt-ell">{n}{" <span class=t-3>(you)</span>" if a == "JP" else ""}</div><div class="caption t-3 mt-ell">{e}</div></div>{status_c}</div></td>'
                    f'<td>{role_c}</td><td>{mfa(m)}</td><td class="t-3">{last}</td><td style="text-align:right;padding-right:12px">{act}</td></tr>')
    table = ('<div class="mt-card" style="overflow:hidden"><div class="mt-row" style="padding:10px 12px;gap:6px;border-bottom:1px solid var(--border-default);flex-wrap:wrap">'
             + '<span style="width:240px">' + inp("Search 54 members", 240, ic="search").replace('class="v mt-ell"', 'class="v ph mt-ell"') + "</span>"
             + chip("All 54", selected=True) + chip("Admin 3") + chip("Lawyer 21") + chip("Paralegal 18") + chip("Read-only 12") + chip("MFA off 3", "alert") + "</div>"
             + '<table class="mt-table"><thead><tr><th>Member</th><th>Role</th><th>MFA</th><th>Last active</th><th></th></tr></thead><tbody>' + "".join(rows) + "</tbody></table>"
             + '<div class="mt-row" style="padding:10px 16px;border-top:1px solid var(--border-subtle)"><span class="caption t-3 mt-grow">Showing 8 of 54. The list loads more as you scroll; search covers everyone.</span>' + btn("Export CSV", "ghost", "sm", "upload") + "</div></div>")
    invites = card("Invites", '<div class="mt-col" style="gap:0">' + "".join(
        f'<div class="mt-col" style="gap:6px;padding:10px 0;border-top:1px solid var(--border-subtle)"><div class="mt-row" style="gap:8px">{icon("mail", None, "t-3")}<span class="label mt-ell mt-grow">{e}</span>{b}</div><div class="mt-row" style="gap:4px;padding-left:24px"><span class="caption t-3 mt-grow">{r} · {s}</span>{btn("Resend", "ghost", "sm")}{btn("Revoke", "ghost", "sm")}</div></div>'
        for e, r, s, b in [("tom.reyes@haleprice.example.com.au", "Lawyer", "sent 2 Oct · expires 9 Oct", badge("Pending", "brand")),
                           ("grace.liu@gmail.example.com", "Paralegal", "sent 18 Sep · expired 25 Sep", badge("Expired", "warning"))])
        + '</div><p class="caption t-3" style="margin:0">Invite links last 7 days. Until email is set up, copy the link from the invite and send it yourself.</p>', btn("Invite people", "secondary", "sm", "user-plus"))
    roles = ["Owner", "Admin", "Lawyer", "Paralegal", "Read-only"]
    mrows = "".join(f'<tr><td class="t-2">{cap}</td>' + "".join(f'<td style="text-align:center;width:120px">{icon("check", "sm", "t-success") if c == "y" else icon("minus", "sm", "t-3")}<span class="mt-sr">{"Yes" if c == "y" else "No"}</span></td>' for c in cells) + "</tr>" for cap, cells in ROLE_MATRIX)
    matrix = card("What each role can do", '<div style="margin:0 -16px"><table class="mt-table" data-density="compact"><thead><tr><th>Can</th>' + "".join(f'<th style="text-align:center;width:120px">{r}</th>' for r in roles) + "</tr></thead><tbody>" + mrows + "</tbody></table></div>"
                  + '<p class="caption t-3" style="margin:0">Roles apply firm-wide. Restricted matters narrow who sees a matter, whatever the role.</p>')
    mfa_note = '<div class="mt-note" data-tone="warning">' + icon("shield") + '<span class="mt-grow"><b>3 people haven’t set up MFA.</b> When MFA is required (Security), they’re asked to set it up at their next sign-in.</span>' + btn("Remind them", "secondary", "sm") + "</div>"
    body = (page_head("Team and roles", "Everyone at Hale &amp; Price, their role and whether their account is protected with multi-factor authentication.", btn("Invite people", "primary", "sm", "user-plus"))
            + mfa_note + f'<div style="display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px;align-items:start">{table}{invites}</div>' + matrix)
    return settings_frame("Team and roles", body)


# ------------------------------------------------------------------ Billing and rates
def billing_rates():
    rates = [("JP", None, "Jordan Price", "Owner · principal", "$480", ""), ("PS", "2", "Priya Shah", "Lawyer · senior associate", "$440", ""), ("AK", "4", "Alexandra Konstantinidou-Fitzwilliam", "Lawyer · associate", "$380", ""),
             ("DK", "3", "Daniel Kim", "Admin · lawyer", "$420", ""), ("MT", "4", "Mia Torres", "Paralegal", "$190", ""), ("LN", "2", "Lan Nguyen", "Paralegal", "Default", "t-3")]
    rrows = "".join(f'<tr><td style="max-width:0;width:60%"><div class="mt-row" style="gap:10px">{avatar(a, hue=h)}<div class="mt-grow"><div class="title mt-ell">{n}</div><div class="caption t-3 mt-ell">{r}</div></div></div></td><td class="num {c}">{v}</td><td style="text-align:right;padding-right:12px">{ibtn("compose", f"Edit rate for {n}", size="sm")}</td></tr>' for a, h, n, r, v, c in rates)
    per_member = card("Rates by person", '<div style="margin:0 -16px"><table class="mt-table"><thead><tr><th>Person</th><th class="num">Hourly, ex GST</th><th></th></tr></thead><tbody>' + rrows + '</tbody></table></div><span class="caption t-3">48 more people use the default rate.</span>', btn("Add a rate", "ghost", "sm", "plus"))
    fees = [("will", "Will and EPA", "Fixed", "$2,200"), ("poa", None, "Fixed", "$650"), ("probate", None, "Hourly", "est. $18,000"), ("loa", None, "Hourly", "est. $16,000"),
            ("admin", None, "Hourly", "est. $12,000"), ("fp", None, "Capped", "cap $22,000"), ("contest", None, "Hourly", "est. $45,000"), ("trust", None, "Fixed", "$1,480 / yr")]
    frows = "".join(f'<tr><td>{tag(t, l)}</td><td>{select_sm(arr).replace("width:220px", "width:104px")}</td><td class="num">{v}</td></tr>' for t, l, arr, v in fees)
    fee_card = card("Fee defaults by matter type", '<p class="caption t-3" style="margin:-6px 0 0">New matters start with these. Each matter can change its own arrangement and costs estimate.</p><div style="margin:0 -16px"><table class="mt-table"><thead><tr><th>Matter type</th><th>Arrangement</th><th class="num">Amount</th></tr></thead><tbody>' + frows + "</tbody></table></div>")
    body = ('<div class="mt-col" style="gap:28px;max-width:720px">'
            + page_head("Billing and rates", "How time becomes money at Hale &amp; Price: rates, units, GST and invoice numbers. Changes apply to time recorded from now on.")
            + sec("Rates and units", "Time is recorded in minutes and billed in units.", [
                setting("Default hourly rate", "For anyone without their own rate below.", inp("440.00", 140, "ex GST", mono=True).replace('<span class="v', '<span class="mono t-3">$</span><span class="v')),
                setting("Billing unit", "6 minutes is 0.1 h, the usual unit for lawyers.", select_sm("6 minutes (0.1 h)")),
                setting("Rounding", "Applies to each time entry, not to the invoice.", select_sm("Round up to the next unit"))])
            + sec("GST and invoices", "What appears on every invoice.", [
                setting("Registered for GST", "Adds 10% GST to fees and taxable disbursements.", switch(True)),
                setting("Invoice number prefix", 'Next invoice: <span class="mono t-2">HP-2026-0143</span>', inp("HP-", 140, mono=True)),
                setting("Payment terms", "Shown on the invoice as the due date.", select_sm("14 days")),
                setting("Trust money on invoices", "Show the trust balance held for the matter (read from your trust software).", switch(False))])
            + save_bar() + "</div>")
    aside = f'<div class="mt-col" style="gap:16px;width:440px;flex:none">{per_member}{fee_card}</div>'
    return settings_frame("Billing and rates", f'<div class="mt-row" style="align-items:flex-start;gap:32px">{body}{aside}</div>')


# ------------------------------------------------------------------ Practice
def practice():
    juris = '<div class="mt-row mt-wrap" style="gap:6px;justify-content:flex-end;max-width:300px">' + chip("Victoria · primary", "check", True) + chip("New South Wales") + chip("Add", "plus", filt=True) + "</div>"
    fmt = '<div class="mt-col" style="gap:6px;align-items:flex-end">' + inp("{TYPE}-{YYYY}-{seq:4}", 220, mono=True) + '<span class="caption t-3">Next: <span class="mono t-2">PRB-2026-0143</span> · <span class="mono t-2">WIL-2026-0144</span></span></div>'
    body = ('<div class="mt-col" style="gap:28px;max-width:720px">'
            + page_head("Practice", "Who the firm is and where it practises. These details appear on letters, invoices and court documents, and set which rules and holidays apply.")
            + sec("Firm details", "As registered with the Victorian Legal Services Board.", [
                setting("Firm name", "Shown in the sidebar, on letterhead and on invoices.", inp(LONG_FIRM, 300)),
                setting("ABN", '<span class="t-success">' + icon("check", "sm") + " Valid ABN</span>", inp("51 824 753 556", 180, mono=True)),
                setting("Office", "The address on letters and court documents.", inp("Level 2, 71 Moorabool St, Geelong VIC 3220", 300)),
                setting("Second office", "Optional.", inp("Suite 4, 350 Collins St, Melbourne VIC 3000", 300))])
            + sec("Jurisdictions and time", "Deadlines use the court’s calendar; reminders use your local one.", [
                setting("Jurisdictions", "Rule sets load for each. Matters default to the primary one.", juris),
                setting("Time zone", "Legal dates are counted in this zone.", select_sm("Australia/Melbourne")),
                setting("Local holidays", "Geelong works on Melbourne Cup Day and takes Geelong Cup Day.", select_sm("Greater Geelong (Geelong Cup Day)"))])
            + sec("Matters and records", "How matters are numbered and how long files are kept.", [
                setting("Matter number format", "<code>{TYPE}</code> type code · <code>{YYYY}</code> or <code>{YY}</code> year · <code>{seq:4}</code> running number.", fmt),
                setting("Keep closed files for", "At least 7 years after a matter closes.", inp("7", 72, "years", mono=True))])
            + "</div>")
    preview = ('<div class="mt-col" style="gap:12px;width:320px;flex:none">'
               + card("How the name fits", '<div class="mt-col" style="gap:8px"><span class="caption t-3">Sidebar (240px)</span><div class="mt-ws" style="width:224px;border:1px solid var(--border-default)">' + avatar("HP", "sm", kind="org") + f'<span class="mt-ell">{LONG_FIRM}</span>' + icon("chevron-down") + "</div>"
                      + '<span class="caption t-3">Invoice header</span><div class="mt-card" data-pad style="box-shadow:none"><div class="label" style="text-wrap:balance">' + LONG_FIRM + '</div><div class="caption t-3">ABN 51 824 753 556 · Level 2, 71 Moorabool St, Geelong VIC 3220</div></div></div>')
               + '<div class="mt-note">' + icon("info") + "<span>Long names truncate in the sidebar with the full name in a tooltip, and wrap everywhere else.</span></div></div>")
    return settings_frame("Practice", f'<div class="mt-row" style="align-items:flex-start;gap:40px">{body}{preview}</div>')


# ------------------------------------------------------------------ Trust account (display only)
def trust():
    # ADR-035: materia never keeps a trust ledger. It shows a balance copied from the firm's trust records, always labelled.
    src = "in-house trust records"
    held = (f'<div class="mt-card mt-stat"><div class="k">Held in trust<span class="mt-ml">{btn("Update", "ghost", "sm")}</span></div><div class="v">$84,210.00</div>'
            f'<div class="f" style="flex-wrap:wrap">as at 2 Oct 2026 · from {src}</div><div class="f">{icon("info", "sm")}Not the trust ledger</div></div>')
    stale = (f'<div class="mt-card mt-stat"><div class="k">Held in trust{badge("Out of date", "warning")}<span class="mt-ml">{btn("Update", "ghost", "sm")}</span></div><div class="v">$5,000.00</div>'
             f'<div class="f" style="flex-wrap:wrap">as at 28 Aug 2026 · from {src}</div><div class="f">{icon("info", "sm")}Not the trust ledger</div></div>')
    dialog = ('<div class="mt-dialog" role="dialog" aria-labelledby="trust-dlg" style="width:100%"><div class="mt-dialog-h"><div class="mt-grow"><h2 id="trust-dlg">Update trust balance</h2>'
              '<div class="caption t-3">WE-118 · Estate of Robert Chen</div></div>' + ibtn("x", "Close", size="sm") + '</div><div class="mt-dialog-b">'
              + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' + field("Amount", "84,210.00", ic="billing") + field("As at", "Mon 5 Oct 2026", ic="calendar") + "</div>"
              + field("Note", placeholder="Where you read it, e.g. trust ledger report 5 Oct", optional=True)
              + f'<div class="caption t-3">Copy the balance from your {src}. The change is recorded in the audit log.</div>'
              + '</div><div class="mt-dialog-f">' + btn("Cancel", "ghost") + btn("Save balance", "primary") + "</div></div>")
    body = ('<div class="mt-col" style="gap:28px;max-width:880px">'
            + page_head("Trust account", "Trust money is receipted, paid and reconciled in your own trust records, which your external examiner checks each year. materia can show a balance you copy from them on each matter, and nothing more.", badge("Owners and admins", None, "lock"))
            + '<div class="mt-note">' + icon("info") + "<span><b>Materia shows a trust balance you copy from your trust records. It is not the trust ledger.</b> Always check your trust records before paying money out.</span></div>"
            + sec("Trust balances on matters", "Off until you turn it on. People with billing access then see the balance on each matter’s Billing tab, and Clerk quotes its as-at date.", [
                setting("Show trust balances on matters", "Nothing is shown on invoices, client exports or emails.", switch(True)),
                setting("Your trust records are kept in", "Named on every balance, as “from …”.", '<span class="mt-row" style="gap:8px">' + select_sm("Other").replace("width:220px", "width:120px") + inp("In-house trust records", 190) + "</span>"),
                setting("Mark a balance out of date after", "Older balances get an amber Out of date chip until someone updates them.", inp("30", 96, "days")),
            ])
            + '<div class="mt-col" style="gap:10px"><h3 style="margin:0;font:600 14px/20px var(--font-sans)">On a matter</h3>'
            + '<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start">'
            + '<div class="mt-col" style="gap:12px">' + held + stale + "</div>" + dialog + "</div>"
            + '<span class="caption t-3">There are no deposit, withdraw or transfer actions anywhere in materia. “Paid from trust” on an invoice is recorded after the trust records show the withdrawal.</span></div>'
            + "</div>")
    return settings_frame("Trust account", body)


# ------------------------------------------------------------------ Integrations
def integrations():
    grid = ('<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start">'
            + integration("M", "Microsoft 365", "Email filing from Outlook, calendar sync and time capture.", "connected", detail="jordan.price@haleprice.example.com.au · connected 4 Aug")
            + integration("G", "Google Workspace", "Gmail filing and Google Calendar.", "reconnect", detail="Signed out on 3 Oct when the password changed. Filing is paused; nothing is lost.")
            + integration("X", "Xero", "Approved invoices and payments, matched to the matter.", "error", err="Xero refused the connection: the organisation’s subscription has lapsed, or an adviser removed materia’s access. 3 approved invoices are waiting. Reconnect with a Xero user who has the Standard role or above.")
            + integration("@", "Inbound email", "Forward or BCC mail to a matter’s address and it’s filed there; anything else waits in Inbox › Unfiled.", "connected", action=btn("Copy address", "ghost", "sm", "copy"), detail='<span class="mono">file@haleprice.in.materia.example</span> · or <span class="mono">we-142@…</span> for one matter')
            + integration("R", "RedCrest", "Probate applications and caveat searches with the Supreme Court of Victoria.", "soon")
            + integration("T", "Trust records (LEAP, Smokeball, Actionstep)", "Read trust balances instead of typing them in. Read-only: materia never writes to trust records.", "soon", detail="For now, copy balances in under Trust account.")
            + "</div>")
    body = ('<div class="mt-col" style="gap:24px;max-width:1000px">'
            + page_head("Integrations", "Services materia connects to. Each connection belongs to the firm; personal mail and calendars connect under Profile.")
            + '<div class="mt-row" style="gap:6px">' + chip("All 6", selected=True) + chip("Needs attention 2", "alert") + chip("Connected 2") + "</div>"
            + grid
            + '<div class="mt-note">' + icon("shield") + "<span>Privileged documents are never sent to an integration without a person choosing to. Integrations see only the matters their connection allows.</span></div></div>")
    return settings_frame("Integrations", body)


# ------------------------------------------------------------------ Security
def security():
    sessions = [("laptop", "MacBook Air · Chrome", "Geelong VIC · 203.0.113.24", "This device", True), ("smartphone", "iPhone · Safari", "Melbourne VIC · 198.51.100.7", "12 min ago", False),
                ("laptop", "Windows PC · Edge", "Geelong VIC · 203.0.113.24", "Fri 2 Oct", False)]
    srows = "".join(f'<tr><td style="width:36px">{icon(i, None, "t-3")}</td><td><div class="title">{d}</div><div class="caption t-3">{w}</div></td><td>{badge(t, "success") if me else "<span class=t-3>" + t + "</span>"}</td><td style="text-align:right;padding-right:12px">{"" if me else btn("Sign out", "ghost", "sm")}</td></tr>' for i, d, w, t, me in sessions)
    body = ('<div class="mt-col" style="gap:28px;max-width:760px">'
            + page_head("Security", "How people sign in to Hale &amp; Price and how long they stay signed in.")
            + sec("Sign-in", "These apply to everyone in the firm.", [
                setting("Require multi-factor authentication", "People without MFA are asked to set it up at their next sign-in. 3 people haven’t yet.", switch(True)),
                setting("Sign out after inactivity", "Counts from the last click or keystroke in any tab.", select_sm("30 minutes")),
                setting("Confirm it’s you for sensitive actions", "Asks for the password or MFA again before changing roles, rates, trust links or exporting.", switch(True)),
                setting("Google sign-in", "Microsoft sign-in comes later.", switch(True))])
            + sec("Your sessions", "Where you’re signed in now. Sign out anything you don’t recognise.", [
                f'<div class="mt-card" style="overflow:hidden"><table class="mt-table"><tbody>{srows}</tbody></table></div>'], btn("Sign out everywhere else", "secondary", "sm"))
            + sec("Someone else’s sessions", "Owners and admins can sign a person out of every device, for example when a laptop is lost.", [
                setting("Sign a person out everywhere", "They stay a member and can sign in again.", btn("Choose person", "secondary", "sm", "user"))])
            + "</div>")
    return settings_frame("Security", body)


# ------------------------------------------------------------------ Audit log
def audit_log():
    rows = [("09:42:18", "PS", "2", "Priya Shah", ("Edited", "brand"), "WE-142 · Key facts", "Date of death: 21 Jul 2026 → 22 Jul 2026", "Web"),
            ("09:40:02", "JP", None, "Jordan Price", ("Accepted", "ai"), "WE-142 · Deadlines", "Clerk suggestion: Publish notice of intended application", "Clerk"),
            ("09:12:55", "DK", "3", "Daniel Kim", ("Role changed", "warning"), "Team · Mia Torres", "Lawyer → Paralegal", "Web"),
            ("08:58:31", "PS", "2", "Priya Shah", ("Viewed", None), "WE-097 · Affidavit of Lan Nguyen", '<span class="t-3">Privileged · content redacted</span>', "Web"),
            ("08:31:07", "AK", "4", "Alexandra Konstantinidou-Fitzwilliam", ("Created", "success"), "WE-172 · Estate of Peter Vance", "New matter from intake", "Web"),
            ("08:30:00", "SY", None, "System", ("Computed", "info"), "WE-118 · Deadlines", "Family provision window: 16 Nov 2026 (APA 1958 (Vic) s 99, rule set v3)", "Deadline engine"),
            ("07:30:12", "SY", None, "System", ("Synced", None), "Trust balances", "4 matters updated from the trust software", "Integration"),
            ("Yesterday", "JP", None, "Jordan Price", ("Exported", "warning"), "Matters list", "CSV of 42 matters · privileged fields excluded", "Web"),
            ("Yesterday", "DK", "3", "Daniel Kim", ("Deleted", "danger"), "WE-160 · Task", "Obtain original will from safe custody", "Web")]
    trs = "".join(f'<tr><td class="mono-s t-3" style="width:96px">{t}</td><td style="max-width:0;width:22%"><div class="mt-row" style="gap:8px">{avatar(a, "sm", hue=h, kind="org" if a == "SY" else None)}<span class="mt-ell">{n}</span></div></td><td>{badge(*b) if b[1] else badge(b[0])}</td>'
                  f'<td class="t-2" style="max-width:0;width:22%"><div class="mt-ell">{r}</div></td><td style="max-width:0;width:34%"><div class="mt-ell t-2">{c}</div></td><td class="t-3">{s}</td></tr>' for t, a, h, n, b, r, c, s in rows)
    filters = ('<div class="mt-row mt-wrap" style="gap:6px;padding:10px 12px;border-bottom:1px solid var(--border-default)">' + chip("Last 7 days", "calendar", True) + chip("Person", "plus", filt=True) + chip("Action", "plus", filt=True)
               + chip("Matter", "plus", filt=True) + chip("Source: Clerk", "x", True) + '<span class="mt-ml" style="width:280px">' + inp("Search records and changes", 280, ic="search").replace('class="v mt-ell"', 'class="v ph mt-ell"') + "</span></div>")
    table = (f'<div class="mt-card" style="overflow:hidden">{filters}<table class="mt-table"><thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Record</th><th>Change</th><th>Source</th></tr></thead><tbody>'
             + '<tr class="group"><td colspan="6"><span class="mt-row">' + icon("chevron-down", "sm") + '<span class="t-1">Today · Mon 5 Oct</span><span class="mt-count">7</span></span></td></tr>' + "".join(trs[:]) + "</tbody></table>"
             + '<div class="mt-row" style="padding:10px 16px;border-top:1px solid var(--border-subtle)"><span class="caption t-3 mt-grow">1–50 of 2,318 entries · kept for 7 years · times in Australia/Melbourne</span>' + btn("Previous", "ghost", "sm", "chevron-left") + btn("Next", "ghost", "sm", trail="chevron-right") + "</div></div>")
    body = page_head("Audit log", "Every change to matters, people and settings, who made it and from where. Entries can’t be edited or deleted. Personal and privileged values are redacted.", btn("Export CSV", "secondary", "sm", "upload")) + table
    return settings_frame("Audit log", body)


SCREENS = [
    ("Settings: Team and roles", "Members with role, MFA and last activity, filters for a 54-person firm, pending and expired invites, suspended people, and what each role can do.", team),
    ("Settings: Billing and rates", "Default rate, unit and rounding, GST, invoice prefix and terms, rates by person and fee defaults by matter type, with an unsaved-changes bar.", billing_rates),
    ("Settings: Practice", "Firm name (a very long one), ABN, offices, jurisdictions, time zone and local holidays, matter number format with a live preview, and retention.", practice),
    ("Settings: Trust account", "Display only, per ADR-035: materia never keeps a trust ledger. Owners and admins turn on balances copied from the firm’s trust records, always labelled “Not the trust ledger” (BILL-11).", trust),
    ("Settings: Integrations", "IntegrationCard grid for Microsoft 365, Google, Xero, inbound email, RedCrest and trust software: connected, reconnect, error (a long message) and not yet available.", integrations),
    ("Settings: Security", "Required MFA, inactivity sign-out, re-confirmation for sensitive actions, your sessions and devices, and signing someone else out.", security),
    ("Settings: Audit log", "A filterable, read-only table of every change: who, action, record, change and source, with redaction and export.", audit_log),
]
