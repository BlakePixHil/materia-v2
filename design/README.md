# materia design (v2)

The redesign of materia as an AI-native practice tool for **Wills & Estates law in Australia**. This folder is the source of truth for the new app's look, components and screens. It is meant to move to the new repo with the Angular build.

- **Design system (reference):** https://claude.ai/artifact/QQ8WDbjwa4QTjSRkL6TfRm. It covers tokens, typography, the 60 components with live previews and guidelines, 18 screens, icons and logos.
- **Screens gallery:** https://claude.ai/artifact/9pCRk8gUok8JWgn8jn8d7y (`mockups/screens.html`)
- **Brand book:** `system/project/README.md`, covering voice, colour, type, layout, states, Clerk rules, iconography and the Angular mapping.

## Direction

The aesthetic is technical and quiet, in the spirit of Linear. Geist and Geist Mono throughout, on a cool slate canvas, with the main panel inset beside a 240px sidebar. Interaction is keyboard-first (⌘K, ⌘J, single-key shortcuts). **#346CFC** is the one action colour. Violet is reserved for **Clerk**, the AI assistant. Dark mode is first-class.

v1 (Newsreader serif, evergreen, Figma file) is superseded.

## Layout

| Path | What |
|---|---|
| `system/palette.py`, `system/tokens.py` | Token source: primitives, semantic colours (light and dark), type, space, radius, shadow, size |
| `system/icons.py` | Lucide icon paths, plus the StatusIcon and PriorityIcon glyphs |
| `system/markup.py`, `system/litigation.py`, `system/components.py`, `system/components_next.py`, `system/components_lit.py` | The component catalogue: guidelines and preview markup |
| `system/charts.py` | Chart helpers: SVG computed from data, with hover targets and a table view |
| `system/screens.py`, `system/screens_lit.py`, `system/screens_next.py` | The 18 screens, composed from components |
| `system/build.py` | Generates everything below |
| `system/project/` | The design-system files as published: `tokens.json`, `components/*/README.md` and `preview.html`, `components/bundle.css`, `fonts/` |
| `system/project/components/bundle.css` | **The component stylesheet for Angular.** `mt-*` classes styled through Angular Primitives' `data-*` state attributes |
| `tokens/materia.tokens.css` | Generated tokens as CSS custom properties, with `[data-theme]` and `prefers-color-scheme` dark blocks and `@font-face` |
| `mockups/screens.html` | Generated standalone screens gallery |

Rebuild after any change with `python3 design/system/build.py`. Don't edit generated files by hand.

## Using it in Angular

1. Import `tokens/materia.tokens.css` and `system/project/components/bundle.css` globally, and self-host the two fonts from `system/project/fonts/`.
2. Put the `mt-*` class on the element carrying the Angular Primitives directive, with variants as data attributes:
   ```html
   <button ngpButton class="mt-btn" data-variant="primary">Publish notice</button>
   <button ngpCheckbox class="mt-check" [(ngpCheckboxChecked)]="done">…</button>
   ```
3. The directives set `data-hover`, `data-press`, `data-focus-visible`, `data-checked` and so on; the CSS reads only those. `bundle.js` imitates them for previews and is not shipped.

The README in the design system has the full component-to-directive map.

## Accessibility notes

- Every text and background pair passes WCAG AA (4.5:1) in both themes, and control borders and focus rings pass 3:1.
- **Exception, by choice:** white text on #346CFC is 4.47:1, just under AA for small text. Labels stay at 13px medium or larger. If strict AA is required, the primary fill can move to `bg-brand-hover` #2459E6 (5.76:1).

## Open items

- **Jurisdiction:** the launch firm is in Victoria (Melbourne and Geelong). The mocks still cite NSW law (Succession Act 2006 ss 57–58, 75–80, 92–93; UCPR; NSW Online Registry). They are illustrative and are retargeted to Victorian law in ticket DES-01: Administration and Probate Act 1958 s 99 (family provision window runs 6 months from the grant), Wills Act 1997, and the Supreme Court Rules O 26 and O 42A. A practitioner reviews all legal rules.
- The existing logo uses #0364B8 and a rounded wordmark that differ from the new UI blue and from Geist. A logo refresh should bring them together.
- Designed in pass two: Insights, Contacts, Settings (Clerk and AI), Onboarding (import from the current materia) and Mobile (Today, Matter, Record by voice). Precedents was removed.
- Litigation (pass three): Disputes hub, dispute matter (family provision), chronology and evidence (will dispute), settlement and costs, and court book. Court rules shown (UCPR r 20.26, r 42.15, Pt 33; Succession Act s 60(2)) are illustrative and need practitioner review.
- Not yet designed: the other Settings pages (team and roles, billing and rates, trust account, integrations), the Inbox, the Clerk full-page view, notifications, and tablet layouts.
- Insights figures are fictional; the chart rules are in the brand book under Charts.
