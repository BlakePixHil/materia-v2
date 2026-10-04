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
