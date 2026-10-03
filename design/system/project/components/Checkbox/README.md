# Checkbox

Independent on/off choices and task completion; `mixed` for a parent whose children are partly checked.

The box is 16px with `border-control` (3.4:1). Checked fills with `bg-brand`. Labels sit to the right in 14px body, with an optional 12px description underneath.

```html
<button ngpCheckbox [(ngpCheckboxChecked)]="done" [ngpCheckboxIndeterminate]="partial" class="mt-check">…</button>
```
Style `[data-checked]`, `[data-indeterminate]`, `[data-hover]`, `[data-focus-visible]`, `[data-disabled]`.
