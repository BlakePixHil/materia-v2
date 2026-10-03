# Menu

Contextual actions from a `more` button or right-click: grouped, with icons, shortcuts and a destructive item last.

Groups are separated by `mt-menu-sep`; labels (`mt-menu-label`) only when there are three or more groups. Destructive items use `data-tone="danger"` and open a confirmation Dialog. Clerk actions use `data-tone="ai"`.

```html
<button ngpMenuTrigger [ngpMenuTrigger]="menu" class="mt-ibtn">…</button>
<ng-template #menu><div ngpMenu class="mt-menu"><button ngpMenuItem class="mt-menu-item">Record time</button></div></ng-template>
```
