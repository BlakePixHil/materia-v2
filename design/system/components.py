"""The component catalogue: (name, group, height, README markdown, preview body)."""
from icons import icon, status, priority
from markup import *

C = []


def comp(name, group, height, readme, body, subtitle=None, col=False, canvas=False):
    C.append(dict(name=name, group=group, height=height, readme=readme.strip() + "\n", body=body, subtitle=subtitle, col=col, canvas=canvas))


def grid(cols, cells, colw="auto"):
    return f'<div class="pv-grid" style="grid-template-columns:{colw} repeat({cols}, max-content)">' + "".join(cells) + "</div>"


def lab(t):
    return f'<span class="pv-label">{t}</span>'


# ======================================================================= Actions
rows = []
for v, lbl, ic in [("primary", "Publish notice", "court"), ("secondary", "Record time", "timer"), ("ghost", "Cancel", None), ("danger", "Delete matter", "trash"), ("ai", "Ask Clerk", "sparkle")]:
    rows.append(lab(v))
    for st in (None, "hover", "focus", "disabled"):
        rows.append(btn(lbl, v, ic=ic, state=st))
body = grid(4, [lab(""), lab("rest"), lab("hover"), lab("focus"), lab("disabled")] + rows)
body += '<div class="mt-row mt-wrap">' + btn("New matter", "primary", "sm", "plus") + btn("New matter", "primary", None, "plus", ["C"]) + btn("New matter", "primary", "lg", "plus") + btn("Filter", "secondary", "sm", "filter") + btn("Export", "secondary", trail="chevron-down") + btn("Saving", "secondary", ic="loader").replace('data-variant="secondary"', 'data-variant="secondary" data-loading') + "</div>"
comp("Button", "Actions", 360, """
# Button

Buttons commit an action; one **primary** (blue) button per view, for the thing the page is for.

**Variants**
- `primary`: the single committed action (Publish notice, Create matter, Save). `bg-brand`, `text-on-brand`.
- `secondary`: supporting actions next to a primary (Record time, Export).
- `ghost`: toolbar, inline and dismiss actions (Cancel, Edit).
- `danger`: destructive confirmation only, inside a dialog. Never as the resting button on a page.
- `ai`: anything that invokes Clerk (Ask Clerk, Draft invoice, Summarise). Always carries the `sparkle` icon so people know a model is involved.

**Sizes** `sm` 28px (tables, cards, toolbars) · `md` 32px (default) · `lg` 36px (page header primary, empty states).

**Content.** Verb first, sentence case, two or three words: “Record time”, not “Time recording”. Show the shortcut with `mt-kbd` when one exists.

**Angular**
```html
<button ngpButton class="mt-btn" data-variant="primary" data-size="md">Publish notice</button>
```
`ngpButton` sets `data-hover`, `data-press`, `data-focus-visible` and `data-disabled`; the CSS reads only those. Loading: add `data-loading` and a `loader` icon first; keep the label.

**Accessibility.** White on `bg-brand` (#346CFC) is 4.47:1. Keep primary labels at 13px medium or larger, and use `bg-brand-hover` (5.76:1) wherever strict AA for small text is required.
""", body, "5 variants × 3 sizes · data-hover · data-press · data-focus-visible · data-disabled")

ib = []
for v in ("ghost", "secondary", "ai"):
    ib.append(lab(v))
    for st in (None, "hover", "focus", "disabled"):
        ib.append(ibtn("sparkle" if v == "ai" else "more", "More actions", v, state=st))
    ib.append(ibtn("sparkle" if v == "ai" else "more", "More actions", v, "sm"))
comp("IconButton", "Actions", 200, """
# IconButton

Icon-only buttons for dense toolbars, row actions and panel chrome; every one needs an `aria-label` and a tooltip.

Use `ghost` by default, `secondary` when it sits beside secondary buttons, and `ai` for Clerk entry points. Sizes: `sm` 28px, `md` 32px. Never use an icon button for the primary action of a page.

```html
<button ngpButton ngpTooltipTrigger [ngpTooltipTrigger]="tip" class="mt-ibtn" data-variant="ghost" aria-label="More actions">…</button>
```
""", grid(5, [lab(""), lab("rest"), lab("hover"), lab("focus"), lab("disabled"), lab("sm")] + ib))

comp("Kbd", "Actions", 120, """
# Kbd

Keyboard hints. materia is keyboard-first, so show the shortcut wherever an action has one: in buttons, menus, tooltips and the command palette.

Use `⌘` for Mac and `Ctrl` for Windows, chosen at runtime. Single letters are uppercase. Keep to one key or one chord.

Core shortcuts: `⌘K` command palette · `⌘J` Ask Clerk · `C` new matter · `T` record time · `G` then `M` go to Matters · `/` search · `Esc` close.
""", '<div class="mt-row mt-wrap" style="gap:20px">' + "".join(f'<span class="mt-row" style="gap:6px"><span class="body-s t-2">{t}</span>{kbd(*k)}</span>' for t, k in [("Command palette", ["⌘", "K"]), ("Ask Clerk", ["⌘", "J"]), ("New matter", ["C"]), ("Record time", ["T"]), ("Go to matters", ["G", "M"])]) + "</div>")

# ======================================================================= Forms
tf = [field("Deceased's full name", placeholder="e.g. Margaret Anne Whitfield", help="As shown on the death certificate."),
      field("Deceased's full name", value="Margaret Anne Whitfield", state="hover", help="As shown on the death certificate."),
      field("Deceased's full name", value="Margaret Anne Whitf", state="focus", help="As shown on the death certificate."),
      field("Date of death", value="31/02/2026", state="invalid", ic="calendar", error="That date doesn’t exist. Check the death certificate."),
      field("Estate value", value="2,840,000", ic=None, suffix="AUD", help="Gross, before liabilities."),
      field("Matter ref", value="WE-142", state="disabled", help="Assigned when the matter is created.")]
comp("TextField", "Forms", 250, """
# TextField

A labelled single-line input with optional helper or error text; the default control for intake forms.

**Anatomy:** label (13px medium, above) → control (32px, `border-control`, `radius-sm`) → helper (12px, `text-tertiary`) or error (12px, `text-danger`, with the `alert` icon).

**States:** rest · hover (`data-hover`) · focus (`data-focus`: `border-focus` + 3px tint) · invalid (`data-invalid`) · disabled (`data-disabled`).

**Writing.** Labels name the thing (“Date of death”), not an instruction. Helpers say where the value comes from. Errors say what’s wrong and how to fix it: “That date doesn’t exist. Check the death certificate.” Never “Invalid input”.

**Formats.** Dates are entered `DD/MM/YYYY` and displayed `22 Jul 2026`. Currency is AUD with a suffix and no symbol in the field.

```html
<div ngpFormField class="mt-field">
  <label ngpLabel class="mt-label">Date of death</label>
  <span class="mt-input"><input ngpInput formControlName="dateOfDeath" /></span>
  <p ngpDescription class="mt-help">As shown on the death certificate.</p>
  <p ngpError class="mt-error">…</p>
</div>
```
""", '<div class="pv-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));width:100%;align-items:start">' + "".join(tf) + "</div>", col=True)

comp("Textarea", "Forms", 170, """
# Textarea

Multi-line text for file notes, instructions and Clerk prompts outside the composer.

Grows with content up to 12 lines, then scrolls. Same states as TextField. File notes accept plain text with @mentions of people and matters.
""", '<div style="width:520px">' + field("File note", placeholder="").replace('<span class="v ph"></span>', '<span class="v" style="white-space:normal">Called Catherine Whitfield. She has the original will and the CBA statements and will drop them in on Friday. Thomas asked her for a copy of the will last week.</span>').replace('class="mt-input"', 'class="mt-input mt-textarea"') + "</div>")

comp("Select", "Forms", 300, """
# Select

Choose one value from a short, known list (matter type, jurisdiction, fee arrangement). Use a Combobox (searchable) for long lists such as people and matters.

The trigger looks like a TextField with an `updown` chevron. Open state uses the focus treatment. Options render in a Menu with a check on the selected item.

```html
<div ngpSelect [(ngpSelectValue)]="type" class="mt-input mt-select">…</div>
<div *ngpSelectPortal ngpSelectDropdown class="mt-menu"><div ngpSelectOption value="probate" class="mt-menu-item">Probate</div></div>
```
""", '<div class="mt-row" style="align-items:flex-start;gap:24px;width:100%"><div style="width:280px" class="mt-col">' + field("Matter type", value="Probate", select=True, help="Sets the statutory deadlines Clerk tracks.") + field("Jurisdiction", value="New South Wales", select=True, state="disabled") + '</div><div style="width:280px" class="mt-col">' + field("Matter type", value="Probate", select=True, state="focus") + '<div class="mt-menu">' + menu_item("Will and enduring documents", "draft") + menu_item("Probate", "court", selected=True, highlighted=True) + menu_item("Letters of administration", "court") + menu_item("Estate administration", "billing") + menu_item("Family provision claim", "scale") + "</div></div></div>")

comp("SearchField", "Forms", 110, """
# SearchField

The global search and command-palette trigger at the top of the sidebar, and the filter field above long lists.

Sits on `bg-sunken` with no border at rest. Pressing `⌘K` anywhere opens the Command palette with the query carried over.
""", '<div style="width:260px">' + '<span class="mt-input mt-search" data-size="sm">' + icon("search") + '<span class="v">Search or jump to…</span>' + kbd("⌘", "K") + "</span></div>" + '<div style="width:320px"><span class="mt-input">' + icon("filter") + '<span class="v ph">Filter matters…</span></span></div>')

cb = [lab(""), lab("off"), lab("on"), lab("mixed")]
for name, kw in [("rest", {}), ("hover", {"hover": True}), ("disabled", {"disabled": True})]:
    cb.append(lab(name))
    for s in ("off", "on", "mixed"):
        cb.append(check(s, **kw))
comp("Checkbox", "Forms", 250, """
# Checkbox

Independent on/off choices and task completion; `mixed` for a parent whose children are partly checked.

The box is 16px with `border-control` (3.4:1). Checked fills with `bg-brand`. Labels sit to the right in 14px body, with an optional 12px description underneath.

```html
<button ngpCheckbox [(ngpCheckboxChecked)]="done" [ngpCheckboxIndeterminate]="partial" class="mt-check">…</button>
```
Style `[data-checked]`, `[data-indeterminate]`, `[data-hover]`, `[data-focus-visible]`, `[data-disabled]`.
""", '<div class="mt-row" style="gap:48px;align-items:flex-start">' + grid(3, cb) + '<div class="mt-col" style="gap:12px">' + check("on", "Original will received", "Held in safe custody since 2019") + check("off", "Death certificate received") + check("mixed", "Asset statements (3 of 5)") + "</div></div>")

comp("Radio", "Forms", 170, """
# Radio

Pick exactly one of two to five visible options (who is applying for probate, fee arrangement).

Use a Select once there are more than five options. Group with `role="radiogroup"` and a visible legend.

```html
<div ngpRadioGroup [(ngpRadioGroupValue)]="applicant"><button ngpRadioItem value="sole" class="mt-radio"></button></div>
```
""", '<div role="radiogroup" class="mt-col" style="gap:12px"><span class="mt-label">Who is applying?</span>' + "".join(f'<label class="mt-choice"><span class="mt-radio" role="radio" tabindex="0" aria-checked="{"true" if i == 0 else "false"}"{" data-checked" if i == 0 else ""}></span><span>{t}<span class="mt-desc">{d}</span></span></label>' for i, (t, d) in enumerate([("Sole executor", "Catherine Whitfield"), ("Both executors", "Catherine Whitfield and Peter Hale"), ("Executor with power reserved", "Peter Hale may apply later")])) + '<label class="mt-choice" data-disabled><span class="mt-radio" role="radio" aria-checked="false" data-disabled></span><span>Administrator</span></label></div>')

comp("Switch", "Forms", 160, """
# Switch

Settings that take effect immediately (Clerk suggestions on/off, calendar sync). Use a Checkbox inside forms that are saved with a button.

```html
<button ngpSwitch [(ngpSwitchChecked)]="enabled" class="mt-switch"><span ngpSwitchThumb class="mt-switch-thumb"></span></button>
```
""", '<div class="mt-col" style="gap:14px">' + switch(True, "Clerk suggestions on Today") + switch(True, "Capture time from email and calendar") + switch(False, "Sync deadlines to Outlook") + switch(False, "Share captured time with the billing partner", disabled=True) + "</div>")

# ======================================================================= Navigation
comp("NavItem", "Navigation", 330, """
# NavItem

Sidebar navigation: an icon, a label and an optional count, in a 240px sidebar on the canvas.

The active item gets `bg-pressed` and primary text. Hover uses `bg-hover`. Counts are mono and tertiary and only show something actionable (unread, due). Pinned matters use a 8px matter-type square instead of an icon. Sections (“Workspace”, “Pinned”) are 12px tertiary labels and can collapse.

```html
<a ngpButton routerLink="/matters" routerLinkActive #rla="routerLinkActive" [attr.data-active]="rla.isActive ? '' : null" class="mt-nav">…</a>
```
""", '<div class="mt-col" style="width:240px;gap:1px;padding:8px;background:var(--bg-canvas);border-radius:10px">' + nav("Today", "today") + nav("Inbox", "inbox", 3, hover=True) + '<div class="mt-nav-section">Workspace</div>' + nav("Matters", "matters", 42, True) + nav("Deadlines", "calendar", 9) + nav("Time and billing", "billing") + nav("Insights", "insights") + '<div class="mt-nav-section">Pinned</div>' + nav("Estate of Margaret Whitfield", None, dot="matter-probate") + nav("Nguyen v Nguyen", None, dot="matter-fp") + "</div>", canvas=True)

comp("Tabs", "Navigation", 120, """
# Tabs

Switch between views of one object (a matter’s Overview, Deadlines, Estate, Parties, Documents, Time). Not for primary navigation.

The active tab gets a 2px `bg-brand` underline. Counts use `mt-count`. Keep labels to one word where possible.

```html
<div ngpTabset><div ngpTabList class="mt-tabs"><button ngpTabButton ngpTabButtonValue="overview" class="mt-tab">Overview</button></div></div>
```
""", '<div class="mt-tabs" style="width:100%">' + "".join(f'<button class="mt-tab"{" data-active" if i == 0 else ""}>{t}{f"<span class=mt-count>{n}</span>" if n else ""}</button>' for i, (t, n) in enumerate([("Overview", None), ("Deadlines", 6), ("Estate", None), ("Parties", 9), ("Documents", 23), ("Time", None), ("Activity", None)])) + "</div>", col=True)

comp("SegmentedControl", "Navigation", 120, """
# SegmentedControl

Switch the layout of the same data: List, Board or Timeline; Week, Month or FY.

Two to four items, each one word. Use icons with labels for view switches.

```html
<div ngpToggleGroup [(ngpToggleGroupValue)]="view" class="mt-seg"><button ngpToggleGroupItem value="list" class="mt-seg-item">List</button></div>
```
""", '<div class="mt-seg">' + "".join(f'<button class="mt-seg-item"{" data-selected" if i == 0 else ""}>{icon(ic)}{t}</button>' for i, (t, ic) in enumerate([("List", "list"), ("Board", "board"), ("Timeline", "calendar")])) + '</div><div class="mt-seg">' + "".join(f'<button class="mt-seg-item"{" data-selected" if i == 1 else ""}>{t}</button>' for i, t in enumerate(["Week", "Month", "FY 2026–27"])) + "</div>")

comp("Breadcrumb", "Navigation", 100, """
# Breadcrumb

The path to the current object in the top bar: section, then the matter ref in mono, then the sub-page.

The last item is primary text with `aria-current="page"`. Never more than three levels.
""", '<nav class="mt-crumbs" aria-label="Breadcrumb"><a class="mt-row" style="gap:6px">' + icon("matters", "sm") + "Matters</a>" + icon("chevron-right") + '<span class="ref">WE-142</span>' + icon("chevron-right") + '<span aria-current="page">Estate of Margaret Whitfield</span></nav>')

cmdk = ('<div class="mt-cmdk"><div class="mt-cmdk-input">' + icon("search") + '<span class="ph">whitf</span>' + kbd("Esc") + '</div><div class="mt-menu"><div class="mt-menu-label">Matters</div>'
        + menu_item(f'Estate of Margaret Whitfield <span class="mono-s t-3">WE-142</span>', "matters", "↵", highlighted=True) + menu_item('Catherine Whitfield <span class="t-3">· Executor</span>', "user")
        + '<div class="mt-menu-label">Actions</div>' + menu_item("Record time on WE-142", "timer", "T") + menu_item("Publish notice of intended application", "court") + menu_item('Ask Clerk about “whitf”', "sparkle", "⌘J", tone="ai")
        + '</div><div class="mt-cmdk-foot"><span>' + kbd("↑") + kbd("↓") + 'Move</span><span>' + kbd("↵") + 'Open</span><span>' + kbd("⌘", "J") + 'Ask Clerk</span></div></div>')
comp("CommandPalette", "Navigation", 400, """
# CommandPalette

`⌘K` from anywhere: jump to a matter, person or document, run an action, or hand the query to Clerk.

Results are grouped (Matters, People, Documents, Actions) and capped at five per group. The last row always offers “Ask Clerk about …”. Arrow keys move, `↵` opens, `⌘↵` opens in a side panel.

```html
<div ngpDialog class="mt-cmdk"><input ngpInput … /><div ngpListbox class="mt-menu"><div ngpListboxOption class="mt-menu-item">…</div></div></div>
```
""", cmdk, canvas=True)

# ======================================================================= Data display
comp("Badge", "Data display", 140, """
# Badge

Short status labels with a dot (or the sparkle for Clerk). Colour never carries the meaning alone: the label always says it.

Tones: neutral (Draft) · brand (In progress, Notice period) · success (Grant issued, Paid) · warning (Awaiting client) · danger (Overdue, FP risk) · info (Filed) · ai (Clerk draft). Use `mt-count` for numbers.
""", "".join([badge("Draft"), badge("Notice period", "brand"), badge("Grant issued", "success"), badge("Awaiting client", "warning"), badge("FP risk", "danger"), badge("Filed", "info"), badge("Clerk draft", "ai", "sparkle"), '<span class="mt-count">6</span>', '<span class="mt-count" data-tone="brand">3</span>']))

comp("MatterTag", "Data display", 120, """
# MatterTag

The matter type, shown wherever a matter is listed. Each type has a fixed colour (`matter-*` tokens), so a family provision claim reads differently from a simple will at a glance.

Will · Power of attorney · Probate · Letters of admin · Estate admin · Family provision · Will dispute · Testamentary trust. The label is always present; the square is a secondary cue.
""", "".join(tag(t) for t in ["will", "poa", "probate", "loa", "admin", "fp", "contest", "trust"]))

comp("DeadlineChip", "Data display", 120, """
# DeadlineChip

When something is due, with urgency computed by the deadline engine: `overdue` (past), `today`, `soon` (within 7 days), `upcoming`, `done`.

Dates are short and absolute (“14 Oct”, “Fri 9 Oct”); relative phrasing (“Overdue 2d”, “In 5 days”) only for the first three urgencies. Add the year when it isn’t this year (“22 Jul 2027”).
""", deadline("Overdue 2d", "overdue") + deadline("Today", "today") + deadline("In 5 days · 7 Oct", "soon") + deadline("28 Oct", "upcoming") + deadline("22 Jul 2027", "upcoming") + deadline("Filed 1 Oct", "done"))

comp("Avatar", "Data display", 140, """
# Avatar

People, organisations and Clerk. Initials fall back over a photo; hues cycle through brand, info, warning and success subtle tints by a stable hash of the person’s id.

Sizes: xs 18 · sm 20 · md 24 · lg 32 · xl 40. Clerk is the only avatar with the violet-to-orange gradient; never use that gradient for anything else. Firms use `data-kind="org"` (rounded square).

```html
<span ngpAvatar class="mt-avatar"><img ngpAvatarImage [src]="photo" /><span ngpAvatarFallback>JP</span></span>
```
""", '<div class="mt-row" style="gap:12px">' + "".join(avatar("JP", s) for s in ["xs", "sm", None, "lg", "xl"]) + '</div><div class="mt-row" style="gap:12px">' + "".join(clerk(s) for s in ["xs", "sm", None, "lg", "xl"]) + '</div><div class="mt-row" style="gap:12px"><span class="mt-avatars">' + avatar("JP") + avatar("PS", hue="2") + avatar("DK", hue="3") + avatar("+2", hue=None) + "</span>" + avatar("HP", "lg", kind="org") + avatar("TW", "lg", hue="risk") + "</div>")

comp("StatusIcon", "Data display", 140, """
# StatusIcon

A 14px glyph for a matter’s or task’s stage, shown before its name in lists and boards. The pie fills as the matter moves through its stages.

draft (dashed, not started) · active (amber pie, fraction of stages done) · review (blue, waiting on the firm) · done (green check) · blocked (red, waiting on something outside the firm). Always paired with the stage name in a tooltip or column.
""", "".join(f'<span class="mt-row" style="gap:6px">{status(k, f, l)}<span class="body-s t-2">{l}</span></span>' for k, f, l in [("draft", 0, "Intake"), ("active", 0.25, "Notice period"), ("active", 0.5, "Collecting assets"), ("review", 0.75, "Partner review"), ("done", 1, "Finalised"), ("blocked", 0, "Waiting on registry")]))

comp("PriorityIcon", "Data display", 110, """
# PriorityIcon

Matter or task priority as signal bars: none, low, medium, high, and urgent (red square). Urgent is reserved for statutory deadlines inside 48 hours or court orders.
""", "".join(f'<span class="mt-row" style="gap:6px">{priority(l)}<span class="body-s t-2">{l.title()}</span></span>' for l in ["none", "low", "medium", "high", "urgent"]))

comp("Progress", "Data display", 130, """
# Progress

Linear progress for stages, budgets and Clerk jobs. Brand for work done, danger when spend passes 80% of a costs estimate, AI gradient only while Clerk is working.
""", '<div class="mt-col" style="width:320px;gap:14px">' + '<div class="mt-row"><span class="body-s t-2 mt-grow">Estate administration</span><span class="mono-s t-3">3 / 9</span></div>' + progress(33) + '<div class="mt-row"><span class="body-s t-2 mt-grow">Costs estimate used</span><span class="mono-s t-danger">86%</span></div>' + progress(86, "danger") + '<div class="mt-row"><span class="body-s t-ai mt-grow">Clerk is reading statements…</span><span class="mono-s t-3">64%</span></div>' + progress(64, "ai") + "</div>")

comp("Stat", "Data display", 170, """
# Stat

A key number with its label and one line of context: billable hours, WIP, unbilled debt, deadlines. Use at most four in a row, only where the number is the point of the page.

Values are `numeric-xl` with tabular figures. Context names the comparison (“of 25 h target”, “▲ $6,120 this week”). Deltas use `mt-delta` with a direction.
""", '<div class="mt-row" style="gap:12px;align-items:stretch;width:100%">' + stat("Billable this week", "18.4", progress(74) + '<span class="mono-s">of 25 h</span>', " h", "timer") + stat("Work in progress", "$42,860", spark()) + stat("Unbilled 30+ days", "$11,205", '<span class="mt-delta" data-dir="down">▲ $2,140</span> since last week', ic="billing") + "</div>", canvas=True)

rows_html = ""
for sel, ref, name, t, st, stage, dl_, who, hue, wip in [
    (True, "WE-142", "Estate of Margaret Whitfield", "probate", ("active", .25), "Notice period", deadline("Today", "today"), "JP", None, "$4,860"),
    (False, "WE-097", "Nguyen v Nguyen", "fp", ("blocked", 0), "Evidence", deadline("Overdue 2d", "overdue"), "DK", "3", "$18,920"),
    (False, "WE-151", "Harriet and Paul Okafor", "will", ("review", .75), "Awaiting signing", deadline("Thu 8 Oct", "soon"), "JP", None, "$2,200")]:
    rows_html += f'<tr{" data-selected" if sel else ""}><td style="width:28px">{check("on" if sel else "off")}</td><td class="ref">{ref}</td><td><span class="mt-row" style="gap:8px">{status(*st)}<span class="title">{name}</span></span></td><td>{tag(t)}</td><td class="t-2">{stage}</td><td>{dl_}</td><td>{avatar(who, hue=hue)}</td><td class="num">{wip}</td></tr>'
comp("Table", "Data display", 230, """
# Table

Dense, scannable lists of matters, entries and documents: 40px rows, 13px text, group rows, and a sticky header.

Columns lead with the ref (mono) and status glyph, then the name, then type, stage, next deadline, owner and money (right-aligned, mono). Selected rows use `bg-selected`; selecting shows the bulk-action bar. Group rows (`.group`) collapse.

Use native `<table>` for semantics; selection follows `ngpListbox` keyboard patterns (↑ ↓, Space, Shift-click).
""", '<div style="width:100%;border:1px solid var(--border-default);border-radius:10px;overflow:hidden"><table class="mt-table"><thead><tr><th></th><th>Ref</th><th>Matter</th><th>Type</th><th>Stage</th><th>Next deadline</th><th>Owner</th><th class="num">WIP</th></tr></thead><tbody><tr class="group"><td colspan="8"><span class="mt-row">' + icon("chevron-down", "sm") + 'Active<span class="mt-count">3</span></span></td></tr>' + rows_html + "</tbody></table></div>", col=True)

# ======================================================================= Overlays & feedback
comp("Menu", "Overlays", 330, """
# Menu

Contextual actions from a `more` button or right-click: grouped, with icons, shortcuts and a destructive item last.

Groups are separated by `mt-menu-sep`; labels (`mt-menu-label`) only when there are three or more groups. Destructive items use `data-tone="danger"` and open a confirmation Dialog. Clerk actions use `data-tone="ai"`.

```html
<button ngpMenuTrigger [ngpMenuTrigger]="menu" class="mt-ibtn">…</button>
<ng-template #menu><div ngpMenu class="mt-menu"><button ngpMenuItem class="mt-menu-item">Record time</button></div></ng-template>
```
""", '<div class="mt-menu" style="width:260px">' + menu_item("Record time", "timer", "T", True) + menu_item("Assign", "user-plus", "A") + menu_item("Copy matter ref", "copy", "⌘⇧C") + '<div class="mt-menu-sep"></div>' + menu_item("Summarise for partner", "sparkle", tone="ai") + menu_item("Draft letter to executors", "sparkle", tone="ai") + '<div class="mt-menu-sep"></div>' + menu_item("Archive", "archive") + menu_item("Delete matter", "trash", tone="danger") + "</div>", canvas=True)

comp("Tooltip", "Overlays", 110, """
# Tooltip

A short label and shortcut for icon buttons and truncated text. Appears after 400ms, never contains actions or anything that must be read.

```html
<button ngpTooltipTrigger [ngpTooltipTrigger]="tip">…</button><ng-template #tip><div ngpTooltip class="mt-tooltip">Record time <kbd class="mt-kbd">T</kbd></div></ng-template>
```
""", '<span class="mt-tooltip">Record time ' + kbd("T") + '</span><span class="mt-tooltip">Ask Clerk ' + kbd("⌘", "J") + '</span><span class="mt-tooltip">Succession Act 2006 (NSW) s 58(2)</span>')

comp("Dialog", "Overlays", 300, """
# Dialog

Confirm a consequential action or collect a few fields without leaving the page. The title is the question; the primary button repeats the verb.

480px wide, `shadow-dialog`, footer on `bg-canvas`. Destructive dialogs use a `danger` button and say exactly what will happen. `Esc` cancels and focus returns to the trigger.

```html
<ng-template #confirm><div ngpDialogOverlay class="mt-overlay"><div ngpDialog class="mt-dialog"><h2 ngpDialogTitle>…</h2></div></div></ng-template>
```
""", '<div class="mt-dialog" role="dialog" aria-labelledby="dlg-t"><div class="mt-dialog-h"><div class="mt-grow"><h2 id="dlg-t">Publish notice of intended application?</h2></div>' + ibtn("x", "Close", size="sm") + '</div><div class="mt-dialog-b"><p style="margin:0">This publishes the probate notice for <b class="t-1">Estate of Margaret Whitfield</b> on the NSW Online Registry. You can file the summons from <b class="t-1">16 Oct</b>.</p>' + check("on", "Add “File probate summons” to the matter’s deadlines") + '</div><div class="mt-dialog-f">' + btn("Cancel", "ghost") + btn("Publish notice", "primary", ic="court") + "</div></div>", canvas=True)

comp("Toast", "Overlays", 230, """
# Toast

Confirms something that just happened, bottom-right, for 5 seconds; with an Undo where the action can be reversed.

Write in past tense: “Notice published”. Clerk toasts announce finished background work (“Clerk drafted 6 time entries”) with a link to review.
""", '<div class="mt-col" style="gap:10px">' + '<div class="mt-toast" data-tone="success"><span class="ic">' + icon("check") + '</span><div class="mt-grow"><div class="tt">Notice published</div><div class="ts">Whitfield · filing opens 16 Oct</div></div>' + btn("Undo", "ghost", "sm") + "</div>" + '<div class="mt-toast" data-tone="ai"><span class="ic">' + icon("sparkle") + '</span><div class="mt-grow"><div class="tt">Clerk drafted 6 time entries</div><div class="ts">2.1 h from yesterday’s email and calendar</div></div>' + btn("Review", "ai", "sm") + "</div>" + '<div class="mt-toast" data-tone="danger"><span class="ic">' + icon("x") + '</span><div class="mt-grow"><div class="tt">Couldn’t sync to Outlook</div><div class="ts">Reconnect your Microsoft account in Settings.</div></div></div></div>', canvas=True)

comp("EmptyState", "Overlays", 260, """
# EmptyState

What an empty list is for and the one action that fills it. One glyph, one sentence, one button, and a Clerk shortcut when Clerk can do the work.
""", '<div class="mt-card" style="width:100%"><div class="mt-empty"><span class="glyph">' + icon("calendar") + '</span><h3>No deadlines this week</h3><p>Deadlines appear here when a matter’s type, jurisdiction and date of death are set.</p><div class="mt-row">' + btn("Add a deadline", "secondary", ic="plus") + btn("Find missing deadlines", "ai", ic="sparkle") + "</div></div></div>", col=True)

# ======================================================================= Clerk
comp("ClerkBrief", "Clerk", 380, """
# ClerkBrief

Clerk’s proactive summary card: a heading that states the conclusion, up to three items, each with its sources and one action.

The card has a 2px violet-to-orange top edge, `border-ai` and `ai-glow`. Each item leads with the matter name in bold, says what changed and what Clerk did, and cites its sources with `mt-cite`. The footer states what Clerk read and when. Use it on Today and at the top of a matter, never more than once per page.
""", '<div class="mt-clerk-card" style="width:100%"><div class="in"><div class="mt-clerk-head">' + clerk("sm") + 'Morning brief<span class="mt-ml mt-row" style="gap:4px">' + btn("Sources", "ghost", "sm", "link") + "</span></div>"
    + '<div class="title-m">Three things need you today</div>'
    + '<div class="mt-col" style="gap:0">' + "".join(f'<div class="mt-row" style="align-items:flex-start;gap:12px;padding:10px 0;border-top:1px solid var(--border-subtle)">{icon(ic, None, "t-" + tone)}<div class="mt-grow mt-col" style="gap:6px"><div class="body t-2"><b class="t-1">{m}</b> {txt}</div><div class="mt-cites">{cs}</div></div>{btn(a, "secondary", "sm")}</div>' for ic, tone, m, txt, cs, a in [
        ("alert", "danger", "Nguyen v Nguyen.", "Service of the plaintiff’s affidavit was due Wednesday. I’ve drafted a consent-extension letter to the other side.", cite("Orders 12 Sep", 1) + cite("Email · K. Ho", 2), "Review draft"),
        ("court", "brand", "Whitfield.", "Publish the probate notice this morning and the summons can be filed from 16 Oct. Doing it before the long weekend starts the 14 days now.", cite("UCPR r 78.3", 3), "Open matter"),
        ("draft", "warning", "Okafor.", "Thursday’s signing still needs a second witness for the enduring power of attorney.", cite("POA Act 2003 (NSW) s 19", 4), "Add task")]) + "</div>"
    + '<div class="mt-clerk-foot">Read 14 matters, 37 emails and your calendar · 7:42 am</div></div></div>', col=True)

comp("ClerkMessage", "Clerk", 380, """
# ClerkMessage

A turn in a conversation with Clerk. People’s messages sit right on `bg-sunken`; Clerk’s sit left with its avatar, in 14/22 reading text.

Clerk answers lead with the conclusion in bold, give the reasons as a short list, cite every factual claim with a numbered `mt-cite` (superscript in text), and end with at most two follow-up actions. Clerk never presents legal advice as settled; it points to the rule and leaves the judgement to the lawyer.
""", '<div class="mt-col" style="gap:16px;width:440px">' + '<div class="mt-msg" data-role="user">Is anyone likely to bring a family provision claim?</div>'
    + '<div class="mt-msg" data-role="clerk">' + clerk("sm") + '<div class="body"><p><b>Most likely Thomas Whitfield, the son.</b> He is an eligible person under s 57(1)(c), and clause 6 of the will leaves him nothing.<sup>1 2</sup></p><ul><li>The $412k super could be designated notional estate because the binding nomination lapsed.<sup>3</sup></li><li>The file note of 14 Aug records Thomas asking for a copy of the will.<sup>4</sup></li></ul><p>A claim must be filed by <b>22 Jul 2027</b>.</p><div class="mt-cites">' + cite("Will · cl. 6", 1) + cite("Succession Act s 57", 2) + cite("Super statement p 2", 3) + cite("File note 14 Aug", 4) + '</div><div class="mt-row">' + btn("Add risk flag", "secondary", "sm", "flag") + btn("Draft advice", "ai", "sm", "sparkle") + "</div></div></div></div>")

comp("Composer", "Clerk", 200, """
# Composer

Where people ask Clerk something. Shows its context (the matter or selection) as a removable chip, accepts attachments and dictation, and sends with `↵`.

The context chip makes scope explicit: Clerk only reads what the chip names. The footer line is fixed: “Clerk can be wrong. Check the citations.”
""", '<div class="mt-composer" style="width:440px"><span class="ctx">' + icon("matters") + "Estate of Margaret Whitfield" + icon("x") + '</span><div class="field">Ask about this estate…</div><div class="bar">' + ibtn("attach", "Attach", size="sm") + ibtn("mic", "Dictate", size="sm") + '<span class="caption t-3 mt-grow" style="text-align:right;margin-right:6px">Clerk can be wrong. Check the citations.</span><button class="mt-send" aria-label="Send">' + icon("send") + "</button></div></div>")

comp("Citation", "Clerk", 110, """
# Citation

Points from a Clerk claim to its source: a document and pinpoint, an email, or a provision. Opens the source at that spot in a side panel.

Format: `Source · pinpoint` in mono (“Will · cl. 6”, “UCPR r 78.3”, “File note 14 Aug”). Numbered when the text uses superscripts.
""", cite("Will · cl. 6", 1) + cite("Death certificate") + cite("Succession Act 2006 (NSW) s 58(2)") + cite("Email · K. Ho 30 Sep") + cite("Westpac statement p 3"))

comp("Suggestion", "Clerk", 170, """
# Suggestion

Something Clerk proposes (a task, a deadline, a time entry) that becomes real only when a person accepts it.

Dashed `border-ai` on `bg-ai-subtle` until accepted. Says what it would create and why (the source). Two actions only: Dismiss (ghost) and the accept verb (ai).
""", '<div class="mt-col" style="width:620px;gap:8px">' + suggestion("Request date-of-death valuation for 14 Ashby St, Mosman", "From will cl. 4(b) and the title search") + suggestion("Add deadline: File probate summons from 16 Oct", "UCPR r 78.3 · 14 days after the notice is published", "Add deadline") + "</div>")

comp("ClerkWorking", "Clerk", 120, """
# ClerkWorking

Shows Clerk is busy and on what. Always names the step (“Reading 4 documents”), never a bare spinner. Respects reduced motion.
""", '<span class="mt-working"><span class="dots"><i></i><i></i><i></i></span><span class="mt-shimmer">Reading Westpac statement, page 3 of 6</span></span>' + '<div style="width:280px">' + progress(64, "ai") + "</div>")

# ======================================================================= Matter patterns
def matter_card(ref, name, t, st, stage, dl_, who, hint=None):
    h = f'<div class="hint">{icon("sparkle")}<span>{hint}</span></div>' if hint else ""
    return f'<div class="mt-matter-card"><div class="top">{status(*st)}<span>{ref}</span><span class="mt-ml">{priority("high") if "Overdue" in dl_ else ""}</span></div><div class="name">{name}</div><div class="meta">{tag(t)}{dl_}<span class="mt-ml mt-avatars">{who}</span></div>{h}</div>'


comp("MatterCard", "Matter patterns", 250, """
# MatterCard

A matter on a board: status glyph and ref, the estate’s name, type, next deadline and owners. Optional Clerk hint for the single most useful next step.

Cards are 12px padded on `bg-surface` with `border-default`; hover lifts the border to `border-strong`. Names wrap to two lines, never truncate mid-word.
""", '<div class="mt-row" style="gap:12px;align-items:flex-start"><div style="width:280px">' + matter_card("WE-142", "Estate of Margaret Whitfield", "probate", ("active", .25), "Notice", deadline("Today", "today"), avatar("JP") + avatar("PS", hue="2"), "Publish the notice today so filing can open 16 Oct.") + '</div><div style="width:280px">' + matter_card("WE-097", "Nguyen v Nguyen", "fp", ("blocked", 0), "Mediation", deadline("Overdue 2d", "overdue"), avatar("DK", hue="3")) + "</div></div>", canvas=True)

comp("TaskRow", "Matter patterns", 210, """
# TaskRow

A to-do on Today or a matter: checkbox, title, the matter it belongs to, due date and owner.

Done tasks strike through in `text-tertiary`. Clerk-proposed tasks use Suggestion until accepted. Rows are 40px minimum.
""", '<div class="mt-col" style="gap:2px;width:620px">' + task("Send estate asset questionnaire to executors", "Estate of Margaret Whitfield", deadline("Today", "today") + avatar("JP")) + task("Search for next of kin for the Fairweather intestacy", "Estate of Doris Fairweather", deadline("Mon 12 Oct", "upcoming") + avatar("PS", hue="2")) + task("Obtain original will from safe custody", "Estate of George Lambert", deadline("Done 2 Oct", "done") + avatar("JP"), True) + "</div>")

comp("Timeline", "Matter patterns", 290, """
# Timeline

Statutory and procedural deadlines in date order. Every item names its rule (Act and section, or court rule) and jurisdiction, so it can be checked rather than trusted.

Node states: done (green check), next (blue, haloed), upcoming (outline), overdue (red). Generated by the deadline engine from the matter type, jurisdiction and date of death; manual items are marked “Added by …”.
""", '<div class="mt-timeline" style="width:520px">' + tl("done", "Caveat search: none lodged", "NSW Online Registry · 2 Oct", deadline("Done", "done")) + tl("next", "Publish notice of intended application", "<code>UCPR r 78.3</code> · at least 14 days before filing", deadline("Today", "today")) + tl("upcoming", "File probate summons", "From 16 Oct · explain any delay after 22 Jan 2027", deadline("16 Oct", "upcoming")) + tl("upcoming", "Family provision claim period ends", "<code>Succession Act 2006 (NSW) s 58(2)</code> · 12 months from death", deadline("22 Jul 2027", "upcoming"), "scale") + "</div>")

comp("TimeEntry", "Matter patterns", 200, """
# TimeEntry

A unit of recorded work in 6-minute units (0.1 h), with its matter, source and value.

Manual entries are solid. Clerk-captured entries are dashed `border-ai` with the source (email, calendar, document) until a fee earner accepts them; nothing is billed without that. Hours and amounts are right-aligned mono.
""", '<div class="mt-col" style="gap:8px;width:600px">' + time_entry("Drafted probate summons and affidavit", "WE-142 · Whitfield · 1 Oct", "1.8 h", "$792.00") + time_entry("Emails with executor re: asset schedule", "3 emails · 10:42–11:05 · WE-142", "0.4 h", "$176.00", "mail", True) + time_entry("Conference with Ms Okafor re: attorneys", "Calendar · 25 min · WE-151", "0.5 h", "Fixed fee", "calendar", True) + "</div>")

STAGES = ["Intake", "Will & assets", "Notice", "Filed", "Grant", "Collect", "Debts & tax", "Distribute", "Finalise"]
comp("EstateStepper", "Matter patterns", 110, """
# EstateStepper

The nine stages of a deceased estate, under the matter title. Done stages fill blue; the current stage is half-filled and its label is primary.

Stages: Intake · Will & assets · Notice · Filed · Grant · Collect · Debts & tax · Distribute · Finalise. Letters of administration uses the same track; family provision claims use their own (Instructions · Notice · Filed · Mediation · Hearing · Orders).
""", '<ol class="mt-stepper" style="width:100%">' + "".join(f'<li data-state="{"done" if i < 2 else "current" if i == 2 else ""}">{s}</li>' for i, s in enumerate(STAGES)) + "</ol>", col=True)

comp("KeyFacts", "Matter patterns", 220, """
# KeyFacts

The facts every later step depends on, as a two-column definition list: deceased, date of death, last address, will, executors, jurisdiction.

Values Clerk extracted show a citation until a person confirms them.
""", '<div class="mt-card" data-pad style="width:440px"><div class="mt-card-h"><h3>Key facts</h3><span class="mt-ml">' + btn("Edit", "ghost", "sm") + '</span></div><dl class="mt-facts"><dt>Deceased</dt><dd>Margaret Anne Whitfield</dd><dt>Date of death</dt><dd>22 Jul 2026 · aged 81</dd><dt>Last address</dt><dd>14 Ashby St, Mosman NSW 2088</dd><dt>Will</dt><dd>3 May 2019 · original held</dd><dt>Executors</dt><dd>Catherine Whitfield, Peter Hale</dd></dl></div>', canvas=True)

comp("Note", "Matter patterns", 160, """
# Note

An inline callout for a fact that changes what the lawyer does next. Info for context, warning for something to act on, danger for a risk.

One or two sentences, with the subject in bold. Pair with one action when there is an obvious next step.
""", '<div class="mt-col" style="width:560px;gap:8px"><div class="mt-note">' + icon("info") + '<span>Superannuation of $412k sits outside the estate. The binding nomination lapsed in March 2024, so the trustee may pay it to the estate.</span></div><div class="mt-note" data-tone="warning">' + icon("alert") + '<span><b>Nguyen v Nguyen</b> has used 86% of the disclosed costs estimate. Tell the client before costs materially exceed it.</span></div></div>')

# ======================================================================= Layout
comp("AppShell", "Layout", 360, """
# AppShell

The frame of every screen: a 240px sidebar on `bg-canvas` and the main panel inset 8px, on `bg-surface` with `radius-xl` and a hairline border. The top bar (48px) holds the breadcrumb and page actions; Clerk opens as a 400px right panel inside the main panel.

The page gutter is 32px. Content max width is unconstrained for tables and 880px for reading views.
""", '<div class="mt-app" style="height:320px;width:100%;--sidebar:180px;border-radius:12px;overflow:hidden;border:1px solid var(--border-default)"><aside class="mt-sidebar"><div class="mt-ws">' + avatar("HP", "sm", kind="org") + 'Hale &amp; Price' + icon("chevron-down") + "</div>" + nav("Today", "today") + nav("Matters", "matters", 42, True) + nav("Deadlines", "calendar") + '</aside><main class="mt-main"><div class="mt-topbar"><nav class="mt-crumbs"><span aria-current="page">Matters</span></nav><span class="mt-ml">' + btn("New matter", "primary", "sm", "plus") + '</span></div><div class="mt-page" style="padding:16px 20px"><div class="title-l">Matters</div><div class="mt-col" style="gap:6px"><div style="height:10px;width:60%;border-radius:4px;background:var(--bg-sunken)"></div><div style="height:10px;width:45%;border-radius:4px;background:var(--bg-sunken)"></div><div style="height:10px;width:52%;border-radius:4px;background:var(--bg-sunken)"></div></div></div></main></div>', col=True, canvas=True)


import json as _json
from pathlib import Path as _Path
_H = _Path(__file__).with_name("component-heights.json")
MEASURED = _json.loads(_H.read_text()) if _H.exists() else {}


def preview(c):
    h = MEASURED.get(c["name"], c["height"]) + 8
    sub = f' subtitle="{c["subtitle"]}"' if c.get("subtitle") else ""
    pv = ' data-col' if c["col"] else ""
    cv = ' data-canvas' if c["canvas"] else ""
    return (f'<!-- @dsCard group="{c["group"]}" height={h}{sub} -->\n<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>{c["name"]}</title></head>\n'
            f'<body>\n<div class="pv mt"{pv}{cv}>\n{c["body"]}\n</div>\n</body>\n</html>\n')
