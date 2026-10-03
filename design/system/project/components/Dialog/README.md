# Dialog

Confirm a consequential action or collect a few fields without leaving the page. The title is the question; the primary button repeats the verb.

480px wide, `shadow-dialog`, footer on `bg-canvas`. Destructive dialogs use a `danger` button and say exactly what will happen. `Esc` cancels and focus returns to the trigger.

```html
<ng-template #confirm><div ngpDialogOverlay class="mt-overlay"><div ngpDialog class="mt-dialog"><h2 ngpDialogTitle>…</h2></div></div></ng-template>
```
