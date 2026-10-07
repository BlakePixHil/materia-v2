# Skeleton

The loading state of a list, card or form: grey bars in the shape of the content that is coming, so the page doesn’t jump when it arrives. Use it for the first load of anything that takes longer than 300ms; refreshes keep the old content and show the 2px loading bar instead.

**Shape.** Match the real layout. `<mt-skeleton>` draws four shapes:

- `rows` (default): list and table rows: a 14px glyph, a ref bar (40px), a title bar (30–52% wide) and a trailing chip. `framed` draws the card when the loaded list sits in one. Six rows fill a table; never more than the screen holds.
- `lines`: a few lines of text for a small panel.
- `cards`: a grid of cards (a board, a matter’s overview).
- `fields`: a settings form, with the title and description on the left and the control on the right.

**Motion.** It waits 150ms before fading in, so a fast load never flashes it, then shimmers slowly (1.6s). The content that replaces it fades in. No shimmer and no fade with `prefers-reduced-motion`.

**Accessibility.** The skeleton is a polite `role="status"` with a visually hidden label (“Loading matters…”); the bars are hidden from screen readers. Where several skeletons draw one region, only the first has a label.

```html
<mt-skeleton framed label="Loading matters…" [count]="6" />
<mt-skeleton variant="fields" framed label="Loading settings…" />
```
