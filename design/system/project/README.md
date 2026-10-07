materia is practice software for Australian Wills & Estates lawyers: matters, statutory deadlines, time and billing, with **Clerk**, an AI assistant, built into every surface. The interface is quiet, dense and keyboard-first. A cool slate canvas, one blue for actions (`blue-500` #346CFC), and violet reserved for Clerk.

Build every screen from these tokens and components. When something is missing, compose it from existing parts before inventing a new one.

## Content fundamentals

**Voice.** Plain English, written for a busy practitioner. Short declarative sentences in the active voice. Say what happened and what to do next. Clerk speaks in the first person (“I’ve drafted…”); the product UI never does.

**Spelling and casing.** Australian English (“organise”, “finalise”, “licence” as the noun). Sentence case everywhere: buttons, titles, menu items, column headers. No emoji, no exclamation marks.

**Legal terms.** Use the term a practitioner uses, exactly:

| Write | Not |
|---|---|
| grant of probate · letters of administration | probate approval · admin letters |
| executor · administrator · beneficiary | owner · heir |
| family provision claim | will challenge · contest |
| notice of intended application | probate ad |
| costs disclosure · costs estimate | quote · price |
| matter | case · job · ticket |

**Formats.**
- Dates: `22 Jul 2026` in UI, `Fri 9 Oct` when the weekday matters, `22/07/2026` only in inputs. Relative dates (“Overdue 2d”, “In 5 days”) only in DeadlineChip.
- Money: AUD with no code in the UI: `$4,860`, `$2.84m` in summaries, `$42.9k` in Stat tiles. Tabular figures always.
- Time: hours to one decimal in 6-minute units: `0.4 h`.
- Matter refs: `WE-142` in `mono-s`. People’s names in full the first time, initials in avatars.
- Rules: `Administration and Probate Act 1958 (Vic) s 99`, then `APA 1958 (Vic) s 99A`; `GCP Rules O 26`. Cite the jurisdiction on first mention. Every rule in the mocks is illustrative until a practitioner signs it off.

**Errors and empty states** say what is wrong and how to fix it: “That date doesn’t exist. Check the death certificate.” Never “Invalid input” or “Something went wrong”.

## Visual foundations

### Colour

- **Canvas and surfaces.** The app sits on `bg-canvas`. The main panel, cards and rows are `bg-surface`. Menus and dialogs are `bg-raised` with `shadow-popover` or `shadow-dialog`. Wells (search, segmented control track) are `bg-sunken`.
- **Text.** `text-primary` for content, `text-secondary` for supporting text, `text-tertiary` for metadata, refs and placeholders. All three pass 4.5:1 on `bg-surface`, `bg-canvas` and `bg-sunken` in both themes.
- **Action blue.** `bg-brand` (#346CFC) only for the primary button, the current-day marker, checked controls and the active tab underline. One primary button per view. Links and blue text use `text-brand`, never `bg-brand`.
- **Clerk violet.** `bg-ai-subtle`, `border-ai`, `text-ai` and `icon-ai` mark anything Clerk produced or will do. The `ai-from` → `ai-to` gradient (violet to orange) appears only on the Clerk avatar, the 2px top edge of ClerkBrief, Clerk progress and the toast icon. Never use violet for anything else.
- **Status.** `status-*` dots and the `bg-*-subtle` / `text-*` pairs carry success, warning, danger and info. Every status also has a word or an icon. Danger is red at a different lightness from success green, and both carry labels.
- **Matter types** have fixed hues (`matter-will`, `matter-poa`, `matter-probate`, `matter-loa`, `matter-admin`, `matter-fp`, `matter-contest`, `matter-trust`), used only in MatterTag squares and pinned-nav dots. `matter-contest` (rose) marks will and estate disputes.
- **Dark theme** is first-class, not inverted: canvas `slate-975`, surface `slate-950`, raised `slate-900`. Brand stays #346CFC; subtle tints become deep navy, violet and so on.

### Type

Geist for everything, Geist Mono for data. Variable font files are in `fonts/`. Both are SIL Open Font License 1.1, © Vercel with basement.studio.

- `display` (32/38, 600, −2.5%): one greeting per page, on Today only.
- `title-l` (24/30): page and matter titles. `title-m` (18/24): dialog and brief headings. `heading` (14/20, 600): card titles.
- `body` (14/20) is the default. `body-s` (13/18) for secondary lines and dense tables. `body-l` (15/24) for long Clerk answers and file notes.
- `label` (13/18, 500) for controls and nav. `label-s` and `caption` (12/16) for chips, helpers and timestamps.
- `eyebrow` (Geist Mono 11, uppercase, +4%) above titles. `mono` and `mono-s` for refs, hours, money and citations.
- `numeric-xl` and `numeric-m` for figures, always tabular.

Tight negative tracking on 18px and above; zero tracking below. Never set body text under 12px.

### Space and layout

- 4px base grid; tokens `space-2` to `space-64`. Inline gaps are `space-6` or `space-8`, card padding `space-16`, page gutter `space-32`.
- **AppShell:** a `sidebar` (240px) on the canvas, and the main panel inset by `space-8` with `radius-xl`, a `border-default` hairline and `shadow-card`. Top bar `topbar` (48px). Clerk opens as a 400px panel inside the main panel, never as a modal.
- Density: controls are `control-md` (32px), compact `control-sm` (28px); table rows `row` (40px).
- Reading views cap at 880px. Tables and boards use the full width.

### Shape, borders, shadows

- Radii: `radius-xs` 4 (badges, tags, checkboxes), `radius-sm` 6 (buttons, inputs, menu items), `radius-md` 8 (menus, inner cards), `radius-lg` 10 (cards, dialogs), `radius-xl` 14 (the main panel), `radius-full` (avatars, switches, pills).
- Borders do the separating: `border-default` around cards and inputs, `border-subtle` between rows. `border-control` (3:1) outlines anything that must be recognised as a control: text fields, checkboxes, radios and switch tracks. `border-strong` is decorative only.
- Shadows stay small: `shadow-control` on secondary buttons, `shadow-card` on cards, `shadow-popover` on floating things, `shadow-dialog` on dialogs and the command palette. `ai-glow` is reserved for ClerkBrief and the Composer.

### States

Components read state from the `data-*` attributes Angular Primitives sets: `data-hover`, `data-press`, `data-focus-visible`, `data-disabled`, `data-checked`, `data-indeterminate`, `data-open`, `data-selected`, `data-active`, `data-highlighted`, `data-invalid`. Hover is `bg-hover`, pressed `bg-pressed`, selected `bg-selected`. Keyboard focus is always `focus-ring`: a solid 2px blue ring with a 2px surface gap, at least 3:1 on every surface. Disabled uses `bg-disabled` and `text-disabled`, with no hover.

### Page states

Every list has the same six states, shown together on the System states screen:

- **Loading:** Skeleton rows in the real layout on first load; refreshes keep the old rows and show the 2px bar.
- **Empty:** an EmptyState that says what the list is for and offers the one action that fills it. A filtered list that comes back empty offers Clear filters instead.
- **Error:** what failed, that nothing is lost, Try again, and a short reference for support.
- **Offline:** a warning Banner; cached rows stay readable with the time they were fetched, and changes queue on the device.
- **No access:** who can open it and how to ask (Request access). Never a bare 403.
- **Read-only role:** an info Banner; create, bulk and edit controls are hidden rather than disabled.

### Motion

Motion says where something came from and that the app heard you. It is quick and quiet: nothing bounces, nothing loops except a loading state, and nothing makes you wait.

- **Tokens.** `motion-fast` 120ms for hover, press and colour changes; `motion-base` 150ms for switches, toggles, tabs and anything leaving; `motion-slow` 200ms for menus, popovers, dialogs, panels, pages and list items arriving. `ease-out` for arriving (the default), `ease-in` for leaving, `ease-in-out` for moving between two places (the sidebar, a sheet's snap point).
- **Overlays.** Menus, selects and popovers scale up from 97% on the trigger's side and fade in over `motion-slow`; they fade out over `motion-fast` and stop taking clicks the moment they start leaving. Tooltips fade in over `motion-fast`. Dialogs and the command palette fade their scrim and rise 8px; sheets slide up from the bottom edge. Toasts rise in and fade out.
- **Pages.** A page rises 4px and fades in over `motion-slow` when you arrive, and so does a matter's tab. Leaving is instant, so navigation never waits on an animation.
- **Lists and cards.** Content that replaces a skeleton fades in. Short lists and card columns rise in one after another, 30ms apart, capped at 150ms; long tables fade in as one so scrolling never re-animates rows.
- **Hover and focus.** Rows, nav items, tabs, chips and cards ease their fill, border and focus ring over `motion-fast`. Menu items highlight instantly, so arrowing through a menu never lags.
- **Loading.** Skeletons wait 150ms before fading in, so a fast load never flashes one. Clerk's working state is three pulsing dots plus a named step.
- **Reduced motion.** With `prefers-reduced-motion`, animations stop and transitions drop to instant; overlays and pages simply appear.

### Charts

Charts answer one question each and use one hue: `icon-brand` bars and lines on `bg-surface`. Bars are at most 24px thick, rounded 4px at the data end and square at a zero baseline. Lines are 2px over a 10% wash, with an end dot and the latest value labelled. Gridlines are 1px `border-subtle`. Targets and benchmarks are solid 1.5px `text-tertiary` lines with a label.

- Label only the latest value and the extreme; axis ticks carry the rest. Text never takes the data colour.
- Never use a second y-axis. Two measures on different scales become two charts.
- Matter-type colours and status colours are not chart series. Compare categories with single-hue bars and put the MatterTag in the label.
- Every mark is a hover and focus target (`data-tip`, value first, then label), and every chart has a “View as table” disclosure with the same numbers.
- One hero figure per dashboard (`mt-hero`, 48px Geist, proportional figures). Stat tiles use proportional figures too; tables and axes use tabular ones.
- Filters for a dashboard sit in one row above all its charts, with the date range first.

### Mobile

Phones (under 768px) get the same tokens at the same sizes, with 15px body text and 16px in fields (so iOS doesn't zoom). Every control is at least 44px each way: `--control-sm` and `--control-md` become 44px and `--control-lg` 48px, and rows (`mt-mrow`) are 56px.

- **Navigation.** A five-item TabBar: Today, Matters, Record, Inbox and More. Record is the raised centre action. More holds everything else (My tasks, Deadlines, Contacts, Safe custody, Time & billing, Insights, Settings), your account, the theme and Sign out; pages reached from it keep More current. The top bar shows the screen's title, a back link where there is one, and your avatar (to More) on tab roots. Both bars respect the safe areas (`viewport-fit=cover`), and the TabBar never moves while a screen loads.
- **Lists.** Phone lists are rows, not tables: Matters is a search field (number, title or client), Recent, then your view. A matter opens on its actions (Call the client, Log time, Add note) and then its sections (Key facts, Deadlines and Tasks open; Documents and Notes closed), each with See all. The top bar's “…” opens the matter's actions as a BottomSheet, including calling or emailing the client.
- **Sheets.** Every Dialog becomes a BottomSheet: full width, from the bottom, the primary action within thumb reach, and lifted above the on-screen keyboard (`--mt-keyboard-inset`).
- **Gestures.** Swipe a task right to finish it and left to snooze it to tomorrow, both with Undo; vertical scrolling and mouse drags are left alone. Pull down at the top of Today, Matters or Inbox to refresh. Documents zoom with a pinch, the zoom buttons, or + and −; Share sends the file itself through the phone's share sheet.
- Each matter leads with its next statutory step.

### Tablet

From 768 to 1199px the sidebar collapses to a 56px rail of icons with tooltips (the rail button or `[` expands it over the page). Pinned matters and section labels hide in the rail. Clerk opens as a 400px sheet over the right side instead of a column. Right-hand columns narrow to 340px, cards stay two-up down to 900px, and tables keep the matter, its next deadline and owner, moving the rest into the row's menu. Touch targets are at least 36px, and 44px on touch-only screens.

### Accessibility

Text pairs meet 4.5:1 in both themes, and controls and focus meet 3:1. The one exception is deliberate: white on `bg-brand` #346CFC is 4.47:1, just under AA for small text. Keep primary labels at 13px medium or larger. Where strict AA is required, primary fills can use `bg-brand-hover` (#2459E6, 5.76:1). Every icon-only button has an `aria-label` and a Tooltip.

## Clerk

Clerk is the assistant’s name. It reads the practice’s matters, documents, email and calendar, and works inside these rules:

1. **Always marked.** Clerk output uses the violet treatment and the Clerk avatar. People should never wonder whether a person or a model wrote something.
2. **Always cited.** Every factual claim carries a Citation to its source (document and pinpoint, email, or provision). Answers lead with the conclusion in bold, give reasons as a short list, and end with at most two actions.
3. **Proposes, never commits.** Tasks, deadlines, time entries, invoices and letters arrive as a Suggestion or a draft. Nothing is filed, sent or billed until a person accepts it.
4. **Scoped.** The Composer’s context chip shows exactly what Clerk is reading. Clerk does not reach outside that scope.
5. **Honest about limits.** The line “Clerk can be wrong. Check the citations.” appears under every Clerk answer surface. Clerk points to the rule and leaves the legal judgement to the lawyer.
6. **Respects privilege.** Documents marked privileged or without prejudice never go into a court book, a brief to the other side or a filed document. Clerk can read them to help the lawyer but flags them wherever they would otherwise leave the firm.
7. **Never predicts outcomes for clients.** Settlement scenarios are labelled estimates from the matter’s own costs and figures, for the lawyer’s advice. They are not shown to clients as predictions.

## Litigation

Contested estates are matters with a court attached: family provision claims, will disputes (capacity, knowledge and approval, undue influence, informal wills) and estate administration disputes. They live under **Disputes** in the sidebar and use the same Matter screen, with litigation tabs: Overview, Orders, Chronology, Evidence, Offers, Costs and Court book.

- **Track.** Disputes use their own stepper: Instructions · Proceeding filed · Evidence · Mediation · Directions · Hearing · Judgment · Costs. A contested probate can name its own stages (Caveat, Subpoenas, Expert reports).
- **Header.** Always show the court and proceedings number (`S ECI 2026 04127`, or `CI-26-01842` in the County Court) and who we act for (“Acting for the plaintiff”).
- **Orders drive the timetable.** Each CourtOrder shows the order’s own words and what it becomes: a deadline, a court event or nothing. Clerk proposes; a person confirms. Orders with a date that depends on another event are flagged until it is known.
- **Court events** (CourtEvent) carry the list, time, attendance mode and what must be ready. Hearings fill the date block with `bg-brand`.
- **Chronology** (ChronologyEvent) is built from the file. Every event cites a source with a pinpoint, and key events are marked by a person. Issue tags use letter codes so they still read in print. Clerk flags gaps in the evidence where they matter, for example around the date a will was made.
- **Evidence** (EvidenceMatrix) maps each issue to the elements that must be proved: Banks v Goodfellow for capacity, the s 91(4) factors for family provision (Administration and Probate Act 1958 (Vic)). Strength is the fee earner’s call.
- **Offers** (OfferCard) record Calderbank offers and offers of compromise (Supreme Court (General Civil Procedure) Rules 2015 O 26) with their expiry. They are without prejudice and stay out of court books.
- **Costs** are tracked against the disclosed estimate, with a prompt to update the disclosure before it is exceeded. ScenarioBars compare what the client nets under each outcome.
- **Court book** (CourtBookIndex) is an index that renumbers as documents move. Clerk checks for missing exhibits, duplicates and privileged material before anyone generates the PDF. Generating never files or serves anything.
- **Limitation periods** for possible claims against estates we act for appear under “To watch” on the Disputes hub until they expire.

## Iconography

Lucide line icons, drawn on a 24px grid with a 1.6 stroke and rendered at 16px (`icon`) or 14px (`icon-sm`), coloured by `currentColor` through the `icon-*` tokens. The set is in the Icons asset group. Domain glyphs: `court` (courts, registries, disputes), `scale` (statutory rules), `draft` (will drafting), `family-tree` (beneficiaries), `shield` (compliance), `sparkle` (Clerk only).

StatusIcon (dashed, pie, check, blocked) and PriorityIcon (signal bars, red urgent square) are materia’s own glyphs. No emoji anywhere.

*Substitution note:* the legacy app used Material Icons Round. v2 moves to Lucide on purpose: its thinner stroke suits Geist and the denser layout.

## Logos

The Logos asset group holds the existing marks, unchanged: the pillar mark with the materia wordmark in logo blue #0364B8 (`black-logo.svg` for light grounds, `white-logo.svg` for dark), and two square app icons, the `m_` terminal mark and the pillar pennant. In the app the sidebar shows the firm (workspace), not the product logo.

*Open item:* the logo blue #0364B8 and the rounded wordmark face predate this system. They differ from the UI blue #346CFC and from Geist. A logo refresh should bring them together. Until then, don’t recolour or redraw the marks.

## Building with it (Angular)

- Load `tokens.css` (or `design/tokens/materia.tokens.css` in the repo) and `components/bundle.css` globally. Set `data-theme="light"` or `"dark"` on `<html>`, or leave it unset to follow the OS.
- Put the `mt-*` class on the element that carries the Angular Primitives directive, and variants as data attributes: `<button ngpButton class="mt-btn" data-variant="primary">`.
- Mapping: Button and IconButton → `ngpButton` · TextField → `ngpFormField`, `ngpLabel`, `ngpInput`, `ngpDescription`, `ngpError` · Select → `ngpSelect` · Checkbox → `ngpCheckbox` · Radio → `ngpRadioGroup`, `ngpRadioItem` · Switch → `ngpSwitch`, `ngpSwitchThumb` · Tabs → `ngpTabset`, `ngpTabList`, `ngpTabButton`, `ngpTabPanel` · SegmentedControl → `ngpToggleGroup` · Menu → `ngpMenuTrigger`, `ngpMenu`, `ngpMenuItem` · Tooltip → `ngpTooltipTrigger`, `ngpTooltip` · Dialog → `ngpDialog`, `ngpDialogOverlay`, `ngpDialogTitle` · CommandPalette → `ngpDialog` + `ngpListbox` · Avatar → `ngpAvatar` · Progress → `ngpProgress` · Toast → `ngpToast`.
- `components/bundle.js` only imitates those directives so previews respond to hover, press and focus. Don’t ship it in the app.
- The Screens group shows how the parts compose: Today, Matter, Matters (list and board), Deadlines, Time and billing, New matter intake, Command palette, Disputes, Dispute matter, Chronology and evidence, Settlement and costs, Court book, Insights, Contacts, Settings (Clerk and AI, Team and roles, Billing and rates, Practice, Trust account, Integrations, Security, Audit log), Inbox, Unfiled email, Notifications, Clerk, Onboarding, Mobile, Tablet (Today, Matter, Matters list) and System states.
- Contacts are one record per person across every matter. Always show a person’s role together with its matter ref, because the same person is often an executor, a beneficiary and a client.
