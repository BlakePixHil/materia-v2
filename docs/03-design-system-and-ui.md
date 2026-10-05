# Design system & UI conventions

## Sources of truth

- **Design system (live):** https://claude.ai/artifact/QQ8WDbjwa4QTjSRkL6TfRm. It has tokens, type, 60 components with previews and guidelines, 18 screens, icons and logos.
- **Screens gallery:** https://claude.ai/artifact/9pCRk8gUok8JWgn8jn8d7y
- **Source code:** `design/` in the legacy repo `BlakePixHil/materia-web-app`, branch `claude/dazzling-lovelace-7nln12`. It is copied into the new repo at `design/` by FND-01. Rebuild it with `python3 design/system/build.py`.
- **Brand book:** `design/system/project/README.md`. It covers voice, colour, type, layout, states, motion, charts, mobile, accessibility, the Clerk rules, litigation and the Angular mapping.

## Look and feel

- The look is technical and quiet, in the spirit of Linear.
- Type: Geist and Geist Mono, self-hosted variable woff2 files.
- Neutrals: cool slate.
- Action colour: **#346CFC** (brand-500) is the only one.
- Violet (and the violet→orange gradient) is **reserved for Clerk**.
- Status colours: green, amber, red, teal.
- Matter-type tokens: `matter-will`, `matter-poa`, `matter-probate`, `matter-loa`, `matter-admin`, `matter-fp`, `matter-contest` (rose) and `matter-trust`.
- Light and dark themes are first-class. They are set with `[data-theme]` on `<html>`, plus `prefers-color-scheme`.
- Layout: a 240px sidebar, the main panel inset, keyboard-first.

## Using it in Angular

1. The tokens and the global base CSS are loaded globally (`styles` in `apps/web/project.json` and in the Storybook targets of `libs/ui/project.json`): `libs/ui/src/generated/tokens.css`, `generated/components/base.css` and `layout.css`, then `libs/ui/src/styles/base.css` (reset, `color-scheme`, canvas background, focus ring, scrollbars, reduced motion). Each component imports its own file from `libs/ui/src/generated/components/<name>.css` with `styleUrl` and `ViewEncapsulation.None`, because the `mt-*` classes are global by design.
2. Put the `mt-*` class on the element that carries the ng-primitives directive. Variants are data attributes.

```html
<button ngpButton class="mt-btn" data-variant="primary" data-size="md">Publish notice</button>
<button ngpCheckbox class="mt-check" [(ngpCheckboxChecked)]="done"></button>
<div ngpMenu class="mt-menu">…</div>
```

3. The ng-primitives directives set the state attributes (`data-hover`, `data-press`, `data-focus-visible`, `data-disabled`, `data-checked`, `data-open`, `data-selected`, `data-active`, `data-highlighted`, `data-invalid`). The CSS reads **only** these.
4. Wrap each primitive in a thin Angular component in `libs/ui`, such as `<mt-button>`. The wrapper uses `hostDirectives` to compose the ng-primitives directive and exposes typed `input()` signals for its variants.

### Syncing the design system (FND-07)

`design/` is the source; `libs/ui/src/generated/` and `apps/web/public/fonts/` are generated from it. Never edit generated files: change `design/system/*.py`, then run

```sh
pnpm materia-scripts sync-design            # runs python3 design/system/build.py, then syncs
pnpm materia-scripts sync-design --skip-build   # sync the already-built design/ outputs only
pnpm materia-scripts sync-design --check    # CI: exits 1 if anything is out of date
```

It needs **Python 3.11+** (macOS `brew install python@3.12`, Ubuntu `sudo apt-get install python3`, Windows `winget install Python.Python.3.12`). It writes:

| Output | From |
| -- | -- |
| `libs/ui/src/generated/tokens.css` | `design/tokens/materia.tokens.css`, with font URLs pointing at `/fonts/` |
| `libs/ui/src/generated/components/<name>.css` | `design/system/project/components/bundle.css`, split by `mt-<name>` prefix (`base`, `layout` and `preview` are the global sections) |
| `libs/ui/src/generated/tokens.ts` | `design/system/project/tokens.json`: `MT_TOKENS` plus token-name types. Use `cssVar('chart-1')` from `@materia/ui` in TS |
| `libs/ui/src/generated/icons.ts` | `design/system/icons.py`: `MT_ICONS` (Lucide icon data under Materia names) and `MT_STATUS_GLYPHS` |
| `apps/web/public/fonts/*.woff2` | `design/system/project/fonts/` (Geist and Geist Mono variable fonts; the sans one is preloaded in `index.html`) |

The `lint` CI job runs `sync-design --check`.

### Theme

- `ThemeService` (`@materia/ui`) holds `theme` (`'system' | 'light' | 'dark'`) and `resolved`, and sets `data-theme` on `<html>` to the resolved value. An explicit choice wins over `prefers-color-scheme`; on `system` it follows OS changes live.
- The preference is stored in localStorage (`mt-theme`, try/catch). When a user is signed in, data-access mirrors it to `users/{uid}.prefs.theme` and calls `applyProfilePreference()` (or provides its own `THEME_PREFERENCE_STORE`).
- An inline script in `apps/web/src/index.html` sets `data-theme` before the app loads, so there is no flash of the wrong theme. Its CSP hash is in `apps/web/csp-hashes.json` (a test keeps it current); FND-22 adds it to the policy.

### Icons

`<mt-icon name="matters" />` renders a design-system icon (any key of `MT_ICONS`) or any Lucide icon node from the data-only `lucide` package (`import { House } from 'lucide'`, then `[name]="House"`), at 14, 16 (default) or 20px with the brand-book 1.6 stroke. It renders the SVG itself: Angular icon libraries ship every icon as a compiled component, which made builds slow and memory-hungry. Icons are decorative unless you pass `label`. The custom status and priority glyph sources are in `libs/ui/src/icons/custom.ts`; their components come later.

### Form controls (FND-08)

Import them from `@materia/ui`. Each one composes ng-primitives, wears the `mt-*` CSS and works with `formControlName`, `[formControl]` and `ngModel`:

| Component | Use |
| -- | -- |
| `button[mtButton]`, `a[mtButton]` | `variant` (`primary`, `secondary`, `ghost`, `danger`, `clerk`), `size`, `iconStart`, `iconEnd`, `kbd`, `loading`. `type="button"` unless you set `type="submit"` |
| `button[mtIconButton]` | Required `icon` and `label` (accessible name and tooltip) |
| `<mt-text-field>`, `<mt-textarea>` | `label`, `description`, `error`, `errorMessages`, `optional`, `required`; text field: `type`, `iconStart`, `suffix`, `[mtPrefix]`/`[mtSuffix]` slots; textarea: `autoGrow` (12 lines), `maxLength` with a count |
| `<mt-select>` | `options` (`MtOption` or `MtOptionGroup`), `placeholder`; type-ahead; a native `<select>` below 768px (`native` forces it) |
| `<mt-checkbox>`, `<mt-switch>` | `label`, `description`; checkbox: `indeterminate` |
| `<mt-radio-group>`, `<mt-segmented-control>` | `options`, `label`; radio: `orientation` |
| `<mt-search-field>` | `label` (accessible name), `variant` (`global` or `filter`), `shortcut`, debounced `queryChange` |
| `<mt-kbd keys="mod+k">` | ⌘ on Mac, Ctrl elsewhere; `g m` for sequences |

Validation: once a control is touched and invalid, its first error shows under it and is linked with `aria-describedby`, and `aria-invalid` is set. The default copy (`MT_ERROR_MESSAGES`) follows the writing rules; override it per field with `errorMessages`. `Components/Reactive forms demo` in Storybook shows every control in one form.

### Overlays and navigation (FND-09)

| Component | Use |
| -- | -- |
| `[mtTooltip]="'Record time'"` (`mtTooltipKbd`, `mtTooltipPlacement`) | Short label after 400ms on hover or keyboard focus, linked with `aria-describedby`. Never the only place essential information appears. IconButton and collapsed NavItem show their label as a tooltip by default |
| `[mtMenuTrigger]="tpl"`, `<mt-menu>`, `button[mtMenuItem]` (`icon`, `kbd`, `tone`), `button[mtMenuItemCheckbox]`, `button[mtSubmenuItem]`, `<mt-menu-separator>`, `<mt-menu-label>` | Contextual actions. Arrows, Home/End, type to move; ArrowRight/ArrowLeft open and close submenus; Escape closes the menu (and only the menu when it's inside a dialog). `MT_MENU` imports them all |
| `<mt-dialog>` (`title`, `description`, `size`, `role`), `[mtDialogTrigger]`, `DialogService` | Modal dialogs: focus trap, focus restore, Escape for the topmost layer, scroll lock |
| `ToastService` | Bottom-right confirmations; see below |
| `mtTabset`, `mtTabList`, `button[mtTab]`, `mtTabPanel`; `mtTabNav` + `a[mtTabLink]` | Views of one object; the link variant when the URL is the source of truth |
| `a[mtNavItem]` (`label`, `icon`, `count`, `dot`, `collapsed`) | Sidebar links; active from `RouterLinkActive` (`data-active`, `aria-current="page"`) |
| `<mt-breadcrumb [items]>` | Path to the current page; collapses the middle when longer than `max` (3) |
| `<mt-tab-bar [items]>` | Phone navigation, at most five items, safe-area padding |
| `<mt-command-palette>` in `<mt-command-palette-overlay>` | Presentational palette (input, grouped results, empty state, footer). The CommandRegistry (FND-12) supplies `groups` and handles `run` |
| `<mt-bottom-sheet title>` | The phone's dialog; drag the handle to expand (50% → 90%) or close; follows the on-screen keyboard with `visualViewport` |

Overlays portal into one container and stack by the `layer-*` tokens (dropdown 1000, overlay 1100, modal 1200, popover 1300, toast 1400, tooltip 1500). Animations stop under `prefers-reduced-motion`.

```ts
// Dialogs: typed data in, typed result out.
const dialogs = inject(DialogService);
const handle = dialogs.open<EditDeadlineData, Deadline>(EditDeadlineDialog, { data: { deadline } });
const updated = await handle.result; // undefined when cancelled

// Inside EditDeadlineDialog (its template's root is <mt-dialog>):
protected readonly ref = injectDialogRef<EditDeadlineData, Deadline>();
save() { this.ref.close(this.form.getRawValue()); }

// Confirmation, with "type the matter number" for destructive actions.
if (await dialogs.confirm({ title: 'Delete WE-142?', confirmLabel: 'Delete matter', tone: 'danger', typedConfirmation: 'WE-142' })) { … }

// Toasts: past tense, one optional action.
inject(ToastService).show({ tone: 'success', title: 'Notice published', action: { label: 'Undo', run: () => undo() } });
```

Toasts: at most three on screen (more queue), 5 seconds by default (`duration: 0` keeps one until dismissed), timers pause while the pointer or focus is on the stack. They never take focus: **F6** moves focus to the newest toast's action, and F6 or Escape returns it. Screen readers hear them through a polite live region; `danger` toasts use an assertive one.

Where ng-primitives isn't used: the toast stack is plain Angular (ng-primitives' toast has no queue limit, assertive tone or F6 shortcut), and the command palette implements the combobox pattern itself (ng-primitives' combobox opens its own dropdown portal). Nothing in `libs/ui` imports the CDK directly; ng-primitives uses it internally for focus and positioning.

### Data display and domain components (FND-10)

These are pure: inputs in, outputs out, no data access. Each takes a view-model interface exported from `libs/ui` (`TaskRowVm`, `MatterCardVm`, `DeadlineVm`, `KeyFactVm`, `TimelineItemVm`, `TimeEntryVm`, `StageVm`, `StepVm`, `PersonRoleVm`), and feature code maps domain records to it.

| Component | Use |
| -- | -- |
| `<mt-badge tone>`, `<mt-matter-tag type>`, `<mt-avatar name src colorKey size kind hue tooltip>`, `<mt-avatar-group people max>`, `<mt-status-icon status label>`, `<mt-priority-icon level>` | Markers. Avatars fall back to initials (also when the image fails) on a colour derived from `colorKey`, so people with the same initials still differ; `tooltip` shows the name |
| `<mt-deadline-chip due completed critical trace label>` | Tone from `due` against `MT_TODAY` in the org timezone: overdue red, today brand, within 3 days amber, otherwise neutral, done green (`deadlineTone()`). Label: `Overdue 2d`, `Today`, `Tomorrow`, `In 5 days`, then `28 Oct` (`deadlineLabel()`). `trace` is the engine's working, in a tooltip; `critical` adds a flag |
| `<mt-progress value max label tone size>`, `<mt-meter value target label tone>` | Completion; a value against a target (the tick) |
| `<mt-stat label value unit icon>` with `<mt-sparkline values label>` or `<mt-delta value direction good>` in its footer | Headline numbers |
| `<mt-empty-state title description icon>`, `<mt-note tone>` | Empty lists (say why, give the next step); inline callouts |
| `<mt-table>` | See below |
| `<mt-task-row [task] editable (done) (titleChange) (open)>` | A task: the checkbox emits `done`; with `editable` the title edits in place (Enter saves, Escape cancels) |
| `<mt-matter-card [matter] (open)>` | Board card. Drag behaviour is added by the board (CORE-04) |
| `<mt-key-facts [facts] (copied)>` + `<ng-template mtFactCitation let-fact>` | Facts with copy buttons; Clerk-sourced facts render the citation template (FND-11's Citation) |
| `<mt-estate-stepper [stages] current completed interactive (stageSelect)>` | The matter's stages from its template |
| `<mt-timeline [items] grouped hasMore loading (loadMore)>` | History or deadlines, grouped by day in the org timezone; kinds note, activity, document, email, clerk, deadline |
| `<mt-time-entry [entry] (accept)>` | A recorded entry (actions projected) or a captured one (Accept) |
| `<mt-person-header>`, `<mt-settings-section>` + `<mt-settings-row>` (put a `<mt-switch labelHidden>` inside), `<mt-integration-card>`, `<mt-step-list>`, `<mt-choice-cards>` (a form control) | People, settings and onboarding |

Formatting pipes, all `en-AU` and the org timezone (`MT_ORG_TIMEZONE`, default `Australia/Melbourne`): `aud` (cents → `$1,234.50`, credit `-$12.00`, null `—`), `units` (minutes → `0.4`, or `0h 24m` with `'hm'`), `dateOnly` (`3 Oct 2026`) and `relativeDate`. Provide `MT_TODAY` for a fixed date in tests and stories. Note that `en-AU` abbreviates some months as `June`, `July` and `Sept`.

**Table.** `<mt-table label [rows] [columns] [rowKey]>` with `MtTableColumn`s (`sortable`, `value`, `sortValue`, `numeric`, `cellClass`, `width`, `headerHidden`) and `<ng-template mtCell="column" let-row>` for custom cells:

- Sorting: header buttons cycle ascending, descending, off, with `aria-sort`. `[(sort)]`, and `sortMode="external"` when the server sorts.
- Selection: `selectable` and `[(selection)]` (row keys), with select-all and a mixed state.
- Keyboard: rows take focus (one tab stop). j/k or ↑/↓ move, Home/End and PageUp/PageDown jump, Enter opens (as does a click), Space or x selects.
- Layout: sticky header in a scroll container (`maxHeight`), and `density="compact"` (32px rows).
- Large tables: from `virtualThreshold` rows (200) only the visible rows render, between spacer rows, with `aria-rowcount`/`aria-rowindex`. Row heights are fixed per density.
- Empty: an `[mtTableEmpty]` element is shown when there are no rows.

### Clerk components and charts (FND-11)

Every Clerk component renders the Clerk mark (`<mt-clerk-mark>`, the violet sparkle avatar), so AI content is always marked; a spec checks it.

| Component | Use |
| -- | -- |
| `<mt-clerk-message [content] [citations] state (retry) (citationOpen)>`, `<mt-user-message>` | An answer. `content` is Markdown, parsed by `parseMarkdown()` into a tree that templates render: never `innerHTML`, raw HTML stays text, links are http(s)/mailto only, images are never loaded. While `state="streaming"`, half-finished syntax (`**bold`, `[1`, an open fence) renders tolerantly and a caret shows. `stopped` and `error` (with Retry) states. `[n]` markers map to the Citation chips. Actions are projected and appear when done |
| `<mt-citation [citation] (open)>` | Source chip (`CitationVm`). Hover/focus previews the quote; `open` emits `{documentId, page, quote}` for the citation viewer (AI-05). `removed` and `restricted` ("Restricted source", no preview) states |
| `<mt-clerk-brief label title [items] (action)>` | Clerk's summary card (`BriefItemVm`) |
| `<mt-clerk-working label steps current progress reducedMotion>` | Working state, announced politely; motion stops under `prefers-reduced-motion` |
| `<mt-suggestion [suggestion] stale busy (accept) (edit) (dismiss)>` | A proposal (Clerk proposes, a person accepts). Project a preview/diff. `stale`: "Data changed since suggested", and Accept becomes Review |
| `<mt-composer scope [(value)] commands streaming (send) (stop) (attach)>` | Grows with its text, ⌘↵/Ctrl+Enter sends, Stop and Escape while streaming, `/` lists commands (↑/↓, Enter or Tab inserts) |

**Charts.** `<mt-bar-chart>` and `<mt-line-chart>` are SVG computed from `ChartDatum[]` (`label`, `value`, `meta`), following the dataviz rules: one brand hue, no dual axes, bars at most 24px with a 4px rounded data end and a square baseline end, a zero baseline (negative values below it), and solid neutral reference lines. Inputs: `label` (the start of the generated `aria-label` summary), `format`/`tickFormat`, `categoryLabel`/`valueLabel` (table headers), `loading` and `emptyText`.

- **BarChart** also takes `orientation` (auto switches to horizontal past 24 bars), `highlight` (other bars mute), `target` and `labelPoints`.
- **LineChart** also takes `comparison` (the same measure for another period, neutral and dashed, never a second hue) and `reference`.
- **Interaction:** every data point is focusable (one tab stop; arrows, Home and End move) with a tooltip on hover and focus. "View as table" shows the same data as a table. The width follows the container.
- **Helpers:** `niceDomain`, `fittedDomain`, `linearScale`, `bandScale`, `verticalBarPath`, `horizontalBarPath` and `chartSummary` are exported for ScenarioBars (LIT-01).

### App shell, shortcuts and commands (FND-12)

The shell lives in `apps/web/src/app/shell/` and matches the Today screen frame. It has a 240px sidebar (`[` collapses it to icons, remembered per user), the inset main panel with breadcrumbs, page actions and a loading bar, and a Clerk panel slot (`⌘J`). Under 768px the TabBar replaces the sidebar. Only signed-in, org-scoped routes get the shell (`orgScopedGuard`, a stub `AuthState` until FND-16). `/auth/**` and `/onboarding` use a minimal layout.

- **Nav:** `NAV_ITEMS` in `shell/nav.ts` is the one list of destinations, each with a `g` key. Feature flags (FND-23) filter it.
- **Routes:** everything is lazy. Unbuilt pages are `planned(path, title, { ticket })` placeholders ("Coming in CORE-14"). Matter tabs live under `/matters/:id/<tab>`; an unknown tab redirects to `overview`. Titles read root to leaf, then "Materia": `Matter · M-2026-0142 · Materia`, and other tabs add their name. Breadcrumbs come from each route's own `data.crumb` or title.
- **Shortcuts:** `inject(ShortcutService).register({ combo: 'mod+e', description, group, handler, when? })` returns an unregister function; call it on destroy. `mod` is ⌘ on a Mac and Ctrl elsewhere. Sequences look like `g m`. Plain keys are ignored in editable fields (modifier combos still work), nothing fires during IME composition, and browser-reserved combos (⌘W, ⌘T…) throw. Everything registered shows in the `?` sheet.
- **Commands:** `inject(CommandRegistry).register({ id, title, group, icon, keywords, shortcut?, when?, run })` adds a command to ⌘K. Async search results come from `registerProvider({ id, group, search(query, signal) })`, which CORE-15 uses for matters, contacts and tasks. The palette shows Recent (the last five commands run), then everything by group. Typing gives fuzzy-ranked commands, then provider results, debounced 150ms; a failing provider shows nothing.
- **Page actions:** put buttons in the header with `<ng-template mtPageActions>…</ng-template>`.
- **Errors:** `GlobalErrorHandler` shows one toast at most every 4s and reports the error through `ERROR_REPORTER`. The default reporter logs the error name only; FND-21 swaps in Sentry.

### Storybook

`pnpm storybook` (port 4400). The toolbar has a Light/Dark theme switch; backgrounds are the `bg-*` tokens; the a11y addon reports violations as errors. `Foundations/Colours`, `Type`, `Spacing` and `Theme` are rendered from `tokens.ts`. CI builds Storybook and runs the test-runner over every story (play functions and a11y): `pnpm nx run ui:test-storybook` against a running Storybook locally.

## Component inventory

Each component's guidelines are on its page in the design system.

- **Base:** AppShell, NavItem, Breadcrumb, Button, IconButton, Kbd, Badge, MatterTag, Avatar, Tooltip, TextField, Textarea, Select, Checkbox, Radio, Switch, SegmentedControl, Tabs, Menu, Dialog, Toast, SearchField, CommandPalette, Progress, EmptyState, Table, StatusIcon, PriorityIcon, DeadlineChip, TaskRow, MatterCard, KeyFacts, EstateStepper, Timeline, Note, Stat, TimeEntry.
- **Clerk:** ClerkMessage, ClerkBrief, ClerkWorking, Suggestion, Citation, Composer.
- **Next:** BarChart, LineChart, Meter, PersonHeader, SettingsRow, IntegrationCard, StepList, ChoiceCard, TabBar, BottomSheet.
- **Litigation:** CourtEvent, CourtOrder, ChronologyEvent, EvidenceMatrix, OfferCard, CourtBookIndex, ScenarioBars.

## Screens

| Screen | Ticket |
|---|---|
| Today | CORE-14 |
| Matter | CORE-06 |
| Matter documents and document viewer | CORE-12 |
| Matters list | CORE-03 |
| Matters board | CORE-04 |
| Deadlines | CORE-10 |
| Time and billing | BILL-03 |
| New matter intake | CORE-05 |
| Command palette | CORE-15 |
| Insights | INS-02 |
| Contacts | CORE-01 |
| Settings | CORE-21, CORE-22, AI-13, INT-05 |
| Onboarding | FND-12 (org setup), MIG-08 (import) |
| Mobile | MOB-02, MOB-03 |
| Disputes | LIT-02 |
| Dispute matter | LIT-03 |
| Chronology and evidence | LIT-06, LIT-07 |
| Settlement and costs | LIT-08 |
| Court book | LIT-09 |

**Not yet designed** (DES-01 designs these first):
- Settings sub-pages: team and roles, billing and rates, trust display, integrations;
- Inbox and notifications;
- the Clerk full-page view;
- tablet layouts.

## UI rules for agents

- **Never hard-code colours or sizes.** Use tokens (`var(--bg-surface)`, `var(--space-3)`). If you need a token that doesn't exist, add it in `design/system/palette.py` or `tokens.py` and rebuild. Don't inline it.
- **Copy:** sentence case, plain Australian English ("organisation", "finalise"), no exclamation marks. Dates read `3 Oct 2026` and use relative dates only within 7 days. Money reads `$1,234.50`.
- **Clerk content is always marked** with the violet Clerk mark and the label "Clerk". It shows its citations and has Accept, Edit and Dismiss controls. Never style Clerk content as system truth.
- **Keyboard:**
  - Every list is navigable with `j`/`k` or the arrow keys, and `Enter` opens the item.
  - `⌘K` opens the palette and `⌘J` opens Clerk.
  - `c` creates in context and `?` opens the shortcut sheet.
  - Shortcuts are registered through `ShortcutService`, so they are discoverable in the palette.
- **Empty states and errors:** every list has an EmptyState with a primary action, a skeleton loading state, and an error state with retry.
- **Charts:** single hue, no dual axes, bars at most 24px with a 4px rounded data end, hover tooltips, and a table view toggle.
- **Mobile:** below 768px use the TabBar and BottomSheet patterns. Hit targets are at least 44px.
- **Accessibility:**
  - Pairs meet AA. One exception: white on brand-500 is 4.47:1, so labels on it are ≥13px medium; use brand-600 #2459E6 if strict AA is required.
  - Focus rings are always visible.
  - Dialogs trap focus.
  - Toasts use `aria-live`.
