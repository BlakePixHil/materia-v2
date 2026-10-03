# Tooltip

A short label and shortcut for icon buttons and truncated text. Appears after 400ms, never contains actions or anything that must be read.

```html
<button ngpTooltipTrigger [ngpTooltipTrigger]="tip">…</button><ng-template #tip><div ngpTooltip class="mt-tooltip">Record time <kbd class="mt-kbd">T</kbd></div></ng-template>
```
