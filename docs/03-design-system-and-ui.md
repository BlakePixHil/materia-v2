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

1. Import `materia.tokens.css` and the component CSS globally. They live in `libs/ui/styles/`, split per component in FND-07.
2. Put the `mt-*` class on the element that carries the ng-primitives directive. Variants are data attributes.

```html
<button ngpButton class="mt-btn" data-variant="primary" data-size="md">Publish notice</button>
<button ngpCheckbox class="mt-check" [(ngpCheckboxChecked)]="done"></button>
<div ngpMenu class="mt-menu">…</div>
```

3. The ng-primitives directives set the state attributes (`data-hover`, `data-press`, `data-focus-visible`, `data-disabled`, `data-checked`, `data-open`, `data-selected`, `data-active`, `data-highlighted`, `data-invalid`). The CSS reads **only** these.
4. Wrap each primitive in a thin Angular component in `libs/ui`, such as `<mt-button>`. The wrapper uses `hostDirectives` to compose the ng-primitives directive and exposes typed `input()` signals for its variants.

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
