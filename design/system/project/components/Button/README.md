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
