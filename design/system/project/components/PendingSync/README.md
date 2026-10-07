# PendingSync

A warning Badge in the top bar, before the timer: how many documents hold changes saved on this device that haven’t reached Materia yet. It counts documents, not edits (three edits to one task are one change).

**When.** Offline, as soon as there is one. Online, only when a change takes longer than 2 seconds to sync (a slow connection), so normal saves never flash it. It clears itself when the last change syncs.

**Content.** “1 change to sync”, “3 changes to sync”. The title says where they are: “Saved on this device. They sync when you’re back online.” On a phone the top bar shows the count alone; screen readers still hear the whole label. `role="status"`.

```html
<mt-pending-sync />
```
