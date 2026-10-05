# Banner

A full-width strip under the top bar for a condition that affects the whole page: you are offline, your role is read-only, or a service the page depends on is failing. It is not for messages about one item (use Note) or for something that just happened (use Toast).

**Tones:** `warning` for offline and degraded service · default (info) for read-only and scheduled things · `danger` for a failure that blocks work · `neutral` for quiet context (“Viewing as Priya Shah”).

**Content.** Say what is happening and what still works, in one sentence: “You’re offline. Changes save on this device and sync when you reconnect.” One action at most, on the right (Retry, Request access).

**Behaviour.** Offline appears after 3 seconds without a connection and clears itself on reconnect with a “Back online” toast. Read-only stays for the whole session. `role="status"` for offline and read-only, `role="alert"` only for danger.

```html
<div class="mt-banner" data-tone="warning" role="status">…</div>
```
