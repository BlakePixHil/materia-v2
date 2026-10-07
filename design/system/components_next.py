"""Second-pass components: charts, contacts, settings, onboarding and mobile."""
import charts
from components import comp, lab
from icons import icon, status
from markup import *

BILLED = [("Oct", 41.2, "Oct 2025"), ("Nov", 47.8, "Nov 2025"), ("Dec", 39.5, "Dec 2025"), ("Jan", 28.1, "Jan 2026"), ("Feb", 44.6, "Feb 2026"), ("Mar", 55.3, "Mar 2026"),
          ("Apr", 46.9, "Apr 2026"), ("May", 58.2, "May 2026"), ("Jun", 63.4, "Jun 2026"), ("Jul", 49.7, "Jul 2026"), ("Aug", 52.1, "Aug 2026"), ("Sep", 46.2, "Sep 2026")]
GRANT = [("Oct", 52, "Oct 2025"), ("Nov", 49, "Nov 2025"), ("Dec", 55, "Dec 2025"), ("Jan", 58, "Jan 2026"), ("Feb", 47, "Feb 2026"), ("Mar", 45, "Mar 2026"),
         ("Apr", 44, "Apr 2026"), ("May", 46, "May 2026"), ("Jun", 43, "Jun 2026"), ("Jul", 42, "Jul 2026"), ("Aug", 40, "Aug 2026"), ("Sep", 41, "Sep 2026")]


def billed_chart(w=760):
    legend = '<div class="mt-legend"><span><i class="key-bar"></i>Billed</span><span><i class="key-line"></i>Monthly target</span></div>'
    return legend + charts.columns(BILLED, 52, w=w, label_idx=(8, 11)) + charts.table_view(["Month", "Billed", "Target"], [(t, f"${v * 1000:,.0f}", "$52,000") for _, v, t in BILLED])


def grant_chart(w=560):
    return charts.line(GRANT, 38, "Registry median 38", w=w, unit=" days") + charts.table_view(["Month", "Median days to grant"], [(t, v) for _, v, t in GRANT])


comp("BarChart", "Charts", 330, """
# BarChart

Columns for a measure over time, horizontal bars for a measure across categories. One series in the brand hue; a solid reference line for a target.

**Marks.** Bars at most 24px thick, 4px rounded at the data end and square at the baseline, always from zero. Gridlines are 1px `border-subtle`; the baseline `border-default`. A target is a solid 1.5px `text-tertiary` line with its label at the right end.

**Labels.** Label only the latest value and the extreme; ticks carry the rest. Text never takes the bar colour. Category labels for matter types carry the type square.

**Interaction.** Every column band is a hover and focus target (`tabindex="0"`, `data-tip`) showing value first, then the label. Every chart has a “View as table” disclosure with the same numbers.

**Never** a second y-axis, never a categorical rainbow. Two measures of different scale become two charts.
""", '<div class="mt-col" style="width:100%;gap:10px">' + billed_chart(720) + "</div>", col=True)

comp("LineChart", "Charts", 290, """
# LineChart

A continuous measure over time: median days to grant, utilisation, WIP. One 2px line in the brand hue over a 10% wash, an end dot with a 2px surface ring, and the current value labelled at the end.

The y-axis may start above zero for lines (never for bars). Reference values (registry medians, targets) are solid 1.5px `text-tertiary` lines, labelled. Hover snaps to the nearest month across the full plot height.
""", '<div style="width:100%">' + grant_chart(600) + "</div>", col=True)

comp("Meter", "Charts", 200, """
# Meter

Progress of one person or matter against a target: utilisation, costs estimate used. The track is a lighter step of the fill’s ramp; the target is a 2px ink tick.

Below target by more than 10 points, the meter turns warning and the value says so. Always show the number beside the meter.
""", '<div class="mt-col" style="width:420px;gap:14px">' + "".join(f'<div class="mt-row" style="gap:12px">{avatar(a, hue=h)}<span class="label" style="width:110px">{n}</span><div class="mt-meter mt-grow"{" data-tone=warning" if v < 65 else ""}><i style="width:{v}%"></i><b style="left:75%"></b></div><span class="mono" style="width:40px;text-align:right">{v}%</span></div>' for a, n, h, v in [("PS", "Priya Shah", "2", 78), ("JP", "Jordan Price", None, 71), ("DK", "Daniel Kim", "3", 62)]) + '<span class="caption t-3">Target 75% · tick marks the target</span></div>')

comp("PersonHeader", "Contacts", 170, """
# PersonHeader

The top of a contact: name, the roles they hold across matters, and compliance status (identity verification, conflict check).

Roles are chips that name the matter ref, because the same person is often an executor on one matter, a beneficiary on another and a client in their own right. Never show a role without its matter.
""", '<div class="mt-col" style="gap:12px;width:100%"><div class="mt-person">' + avatar("CW", "xl") + '<div class="mt-col" style="gap:2px"><span class="nm">Catherine Whitfield</span><span class="body-s t-3">Belmont VIC · client since 2019</span></div><span class="mt-ml mt-row">' + badge("ID verified", "success") + badge("Conflict check clear", "success") + '</span></div><div class="mt-roles"><span class="mt-role">Executor<span class="ref">WE-142</span></span><span class="mt-role">Beneficiary 50%<span class="ref">WE-142</span></span><span class="mt-role">Will client<span class="ref">WE-031</span></span></div></div>', col=True)

comp("SettingsRow", "Settings", 260, """
# SettingsRow

One setting: a label, one line of consequence, and its control on the right (Switch, Select or Button). Rows group into bordered sections with a heading and a sentence that says what the group controls.

A setting the firm cannot change shows a lock and says why. Settings that widen what Clerk can read or do say so in plain words (“Clerk will read emails filed to a matter”).

A section can also hold fields, notes and buttons: they sit 12px apart, and consecutive rows still join into one bordered list. A person’s row leads with their avatar. When a row’s controls don’t fit beside a readable title (about 240px), they wrap under it, still at the end, rather than squeezing the title.
""", '<div class="mt-col" style="width:640px;gap:28px"><div class="mt-settings-section"><h3>What Clerk can read</h3><p>Clerk only reads what is switched on here, and only within matters the person asking can open.</p>'
    + f'<div class="mt-setting"><div class="tx"><div class="tt">Matter documents</div><div class="ts">Wills, certificates, statements and correspondence filed to a matter.</div></div>{switch(True)}</div>'
    + f'<div class="mt-setting"><div class="tx"><div class="tt">Email</div><div class="ts">Only emails filed to a matter or exchanged with a matter’s contacts.</div></div>{switch(True)}</div>'
    + f'<div class="mt-setting" data-locked><div class="tx"><div class="tt">Send email or file documents {icon("shield")}</div><div class="ts">Clerk never sends, files or bills anything. A person always does.</div></div>{switch(False, disabled=True)}</div></div>'
    + '<div class="mt-settings-section"><h3>Invoices</h3><p>What appears on every invoice.</p>'
    + f'<div class="mt-setting"><div class="tx"><div class="tt">Registered for GST</div><div class="ts">Invoices show GST and are titled “Tax invoice”.</div></div>{switch(True)}</div>'
    + field("Invoice number prefix", "HP-") + field("Payment terms", "14", suffix="days") + "</div>"
    + '<div class="mt-settings-section"><h3>Members</h3>'
    + f'<div class="mt-setting">{avatar("PS", hue="2")}<div class="tx"><div class="tt">Priya Shah</div><div class="ts">priya.shah@haleprice.example.com.au · Lawyer · $440.00/h</div></div><span class="mt-row" style="gap:8px">{btn("Rate and budget", "secondary", "sm")}{field(None, "Lawyer", select=True, size="sm")}{btn("Suspend…", "secondary", "sm")}{btn("Transfer ownership…", "secondary", "sm")}{btn("Remove", "secondary", "sm")}</span></div>'
    + f'<div class="mt-setting">{avatar("JP")}<div class="tx"><div class="tt">Jordan Price (you)</div><div class="ts">jordan.price@haleprice.example.com.au · Owner</div></div><span class="body-s t-2">Owner</span></div></div></div>')

comp("IntegrationCard", "Settings", 150, """
# IntegrationCard

A connected service: its mark (supplied by the service; a monogram until then), what materia uses it for, its status and one action.
""", '<div class="mt-col" style="width:520px;gap:8px">' + f'<div class="mt-integration"><span class="logo">O</span><div class="mt-grow"><div class="label">Outlook and Microsoft 365</div><div class="caption t-3">Email filing, calendar sync, time capture</div></div>{badge("Connected", "success")}{btn("Manage", "ghost", "sm")}</div>' + f'<div class="mt-integration"><span class="logo">R</span><div class="mt-grow"><div class="label">RedCrest</div><div class="caption t-3">Probate applications and caveat searches, Supreme Court of Victoria</div></div>{btn("Connect", "secondary", "sm")}</div></div>')

comp("StepList", "Onboarding", 280, """
# StepList

A vertical list of setup steps, done steps filled blue, the current step ringed. Each step has a one-line description. Steps can be revisited; skipped steps stay unfilled.
""", '<ol class="mt-steps" style="width:300px">' + "".join(f'<li data-state="{s}"><span class="n">{icon("check") if s == "done" else i + 1}</span><span>{t}<span class="sub">{d}</span></span></li>' for i, (s, t, d) in enumerate([("done", "Your firm", "Name, ABN, trust account"), ("done", "Email and calendar", "Outlook connected"), ("current", "Bring in your matters", "From materia, a spreadsheet or another system"), ("", "Practice settings", "Jurisdictions, rates, rule sets"), ("", "Invite your team", "Roles and supervision")])) + "</ol>")

comp("ChoiceCard", "Forms", 200, """
# ChoiceCard

A large radio option with a glyph, a title and one line of detail, for decisions that deserve a sentence each (import source, matter type at intake). Selected uses the brand border and `bg-selected`.

```html
<div ngpRadioGroup><div ngpRadioItem value="materia" class="mt-choice-card">…</div></div>
```
""", '<div role="radiogroup" class="mt-col" style="width:560px;gap:8px">' + f'<div class="mt-choice-card" role="radio" aria-checked="true" data-selected><span class="glyph">{icon("inbox")}</span><div><div class="tt">materia (current version)</div><div class="ts">42 matters, 318 contacts and 1,208 safe-custody wills found.</div></div></div>' + f'<div class="mt-choice-card" role="radio" aria-checked="false"><span class="glyph">{icon("upload")}</span><div><div class="tt">Spreadsheet</div><div class="ts">CSV or Excel. Clerk maps your columns.</div></div></div></div>')

comp("TabBar", "Mobile", 120, """
# TabBar

Primary navigation on phones (under 768px): Today, Matters, Record, Inbox and More. The centre item is the Record screen (log time or a file note, and voice when it ships), raised as a 48px button labelled “Record” for screen readers. Inbox carries its unread count. More holds the rest of the sidebar, your account and the theme; any page reached from it keeps More current.

Fixed to the bottom with the safe area below it, the same height from the first frame (no layout shift). Targets are at least 44px.
""", '<div class="mt-tabbar" style="width:390px;border:1px solid var(--border-default);border-radius:12px">' + f'<a data-active>{icon("today")}Today</a><a>{icon("matters")}Matters</a><a aria-label="Record"><span class="fab">{icon("mic")}</span></a><a>{icon("inbox")}Inbox</a><a>{icon("more")}More</a></div>', canvas=True)

comp("MobileRow", "Mobile", 330, """
# MobileRow

The phone's list row (`mt-mrow`): an icon or a matter-type dot, a title and a subtitle, and a chevron, a DeadlineChip or a count at the end. At least 56px tall and the full width, so the whole row is the target. As a link or button it darkens while pressed (`bg-pressed`) and shows the focus ring when reached by keyboard. `data-tone="danger"` for Sign out.

Groups of rows sit under a MobileGroup heading (`mt-mgroup`): 12px uppercase `text-tertiary`, 20px above. Used by More, Matters, a matter's sections and the matter actions sheet.
""", '<div class="mt-col" style="width:390px;gap:0;padding:0 16px;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:12px">'
    + '<span class="mt-mgroup" style="margin-top:12px">Recent</span>'
    + f'<a class="mt-mrow"><span style="flex:none;width:10px;height:10px;border-radius:3px;background:var(--matter-probate)"></span><span class="mt-col mt-grow" style="gap:0;align-items:flex-start"><span class="tt mt-ell">Estate of Margaret Whitfield</span><span class="ts mono-s">WE-142</span></span>{deadline("Today", "today")}</a>'
    + '<span class="mt-mgroup">This device</span>'
    + f'<button class="mt-mrow">{icon("moon")}<span class="tt mt-grow">Dark theme</span></button>'
    + f'<button class="mt-mrow" data-tone="danger" style="border-bottom:0">{icon("log-out")}<span class="tt mt-grow">Sign out</span></button></div>', canvas=True)

comp("PullToRefresh", "Mobile", 170, """
# PullToRefresh

Pull down at the very top of Today, Matters or Inbox to load them again. A pill under the top bar follows the finger: “Pull to refresh”, then “Release to refresh” in brand blue past 64px, then a spinning “Refreshing…” (`role="status"`) until the screen has its data.

Only one finger, only from the top of the page, and never while it's already refreshing. The browser's own pull-to-reload is off on these screens (`overscroll-behavior-y: contain`), so the page never reloads under you. With reduced motion the pill appears without sliding and the icon doesn't spin.

```html
<mt-pull-refresh [refreshing]="loading()" (refresh)="reload()" />
```
""", '<div class="mt-row" style="gap:16px">'
    + f'<div class="mt-ptr" data-pulling style="position:static;transform:none">{icon("refresh")}Pull to refresh</div>'
    + f'<div class="mt-ptr" data-pulling data-ready style="position:static;transform:none">{icon("refresh")}Release to refresh</div>'
    + f'<div class="mt-ptr" data-refreshing style="position:static;transform:none">{icon("refresh")}Refreshing…</div></div>', canvas=True)

comp("BottomSheet", "Mobile", 330, """
# BottomSheet

The phone’s dialog: slides up over the current screen for a short task (record time, confirm a deadline). Grab handle, a title, the content, and the primary action at the bottom within thumb reach.

Under 768px every Dialog takes this shape by itself (`libs/ui` dialog CSS), so features don't build a second version. It rises above the on-screen keyboard (`--mt-keyboard-inset`), scrolls inside when it's taller than the screen, and closes with the Close button, Esc or a tap on the overlay.
""", '<div style="position:relative;width:390px;height:300px;border-radius:16px;overflow:hidden;background:var(--bg-canvas);border:1px solid var(--border-default)"><div class="mt-sheet"><span class="grab"></span><div class="title-m">Record time</div>' + time_entry("Call with Peter Hale re: share registry", "WE-118 · from your voice note", "0.2 h", "$88.00", "phone", True, False) + btn("Save entry", "primary", "lg") .replace('class="mt-btn"', 'class="mt-btn" style="width:100%"') + "</div></div>", canvas=True)
