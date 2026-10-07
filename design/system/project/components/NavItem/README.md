# NavItem

Sidebar navigation: an icon, a label and an optional count, in a 240px sidebar on the canvas.

The active item gets `bg-pressed` and primary text. Hover uses `bg-hover`. Counts are mono and tertiary and only show something actionable (unread, due). Pinned matters use a 8px matter-type square instead of an icon. Sections (“Workspace”, “Pinned”) are 12px tertiary labels. Pinned is a button that collapses its list (`.mt-nav-section[data-toggle]` over a `.mt-nav-group`): a chevron shows on hover and focus, turns to point right while closed, and the list slides shut. The choice is remembered per person, and the section hides when nothing is pinned and in the rail.

```html
<a ngpButton routerLink="/matters" routerLinkActive #rla="routerLinkActive" [attr.data-active]="rla.isActive ? '' : null" class="mt-nav">…</a>
```
