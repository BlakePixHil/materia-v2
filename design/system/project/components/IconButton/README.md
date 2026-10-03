# IconButton

Icon-only buttons for dense toolbars, row actions and panel chrome; every one needs an `aria-label` and a tooltip.

Use `ghost` by default, `secondary` when it sits beside secondary buttons, and `ai` for Clerk entry points. Sizes: `sm` 28px, `md` 32px. Never use an icon button for the primary action of a page.

```html
<button ngpButton ngpTooltipTrigger [ngpTooltipTrigger]="tip" class="mt-ibtn" data-variant="ghost" aria-label="More actions">…</button>
```
