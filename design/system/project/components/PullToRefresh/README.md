# PullToRefresh

Pull down at the very top of Today, Matters or Inbox to load them again. A pill under the top bar follows the finger: “Pull to refresh”, then “Release to refresh” in brand blue past 64px, then a spinning “Refreshing…” (`role="status"`) until the screen has its data.

Only one finger, only from the top of the page, and never while it's already refreshing. The browser's own pull-to-reload is off on these screens (`overscroll-behavior-y: contain`), so the page never reloads under you. With reduced motion the pill appears without sliding and the icon doesn't spin.

```html
<mt-pull-refresh [refreshing]="loading()" (refresh)="reload()" />
```
