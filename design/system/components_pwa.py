"""The installable app's components (MOB-01): the update toast, Pending sync, Needs connection and the install steps."""
from components import comp, lab
from icons import icon
from markup import *


def toast(title, sub, ic, action="", tone=None):
    t = f' data-tone="{tone}"' if tone else ""
    ts = f'<div class="ts">{sub}</div>' if sub else ""
    return f'<div class="mt-toast"{t}><span class="ic">{icon(ic)}</span><div class="mt-grow"><div class="tt">{title}</div>{ts}</div>{action}</div>'


def pending(n):
    word = "change" if n == 1 else "changes"
    return f'<span class="mt-badge" data-tone="warning" role="status">{n} {word} to sync</span>'


comp("AppUpdate", "Feedback", 420, """
# AppUpdate

How a new version of Materia reaches an open tab. Materia checks a minute after it starts, every 30 minutes while it’s visible, and when you come back to a tab left for half an hour.

**New version.** A toast that stays until it’s used: “New version available”, “Reload to start using it. Anything you’ve saved stays as it is.”, and Reload. Reload moves every open tab to the new version together, after any changes saved on this device have synced (10 seconds at most).

**Too old to keep working.** When the API has moved past this copy (`system-ping` returns a `minClientVersion` above the build’s), a Dialog asks once: “Reload to keep working”, with **Reload now** and **Save my work first**. Saving first leaves a toast with Reload that stays until it’s used. Never reload on its own: a half-filled form would be lost.
""", '<div class="mt-col" style="gap:16px">'
    + toast("New version available", "Reload to start using it. Anything you’ve saved stays as it is.", "refresh", btn("Reload", "secondary", "sm"))
    + '<div class="mt-dialog" role="dialog" aria-labelledby="upd-t" style="width:400px"><div class="mt-dialog-h"><div class="mt-grow"><h2 id="upd-t">Reload to keep working</h2></div></div>'
    + '<div class="mt-dialog-b"><p style="margin:0">Materia has been updated, and this copy is too old to keep saving reliably. Save anything you’re in the middle of, then reload.</p></div>'
    + '<div class="mt-dialog-f">' + btn("Save my work first", "ghost") + btn("Reload now", "primary") + "</div></div>"
    + toast("Reload Materia when you’ve saved your work", None, "refresh", btn("Reload", "secondary", "sm"))
    + "</div>", canvas=True)

comp("PendingSync", "Feedback", 150, """
# PendingSync

A warning Badge in the top bar, before the timer: how many documents hold changes saved on this device that haven’t reached Materia yet. It counts documents, not edits (three edits to one task are one change).

**When.** Offline, as soon as there is one. Online, only when a change takes longer than 2 seconds to sync (a slow connection), so normal saves never flash it. It clears itself when the last change syncs.

**Content.** “1 change to sync”, “3 changes to sync”. The title says where they are: “Saved on this device. They sync when you’re back online.” On a phone the top bar shows the count alone; screen readers still hear the whole label. `role="status"`.

```html
<mt-pending-sync />
```
""", '<div class="mt-col" style="gap:12px">'
    + '<div class="mt-row" style="gap:12px">' + lab("desktop") + pending(1) + pending(3) + "</div>"
    + '<div class="mt-row" style="gap:12px">' + lab("phone") + '<span class="mt-badge" data-tone="warning" role="status" aria-label="3 changes to sync">3</span></div>'
    + "</div>")

comp("NeedsConnection", "Actions", 170, """
# NeedsConnection

A button whose action only the server can do (issue an invoice, run a conflict check, generate a document, send an invite) while the browser is offline. Everything that saves on the device keeps working; these can’t.

**Look.** The button is disabled but stays focusable, and its title reads “Needs connection”. Clicking it explains instead of doing nothing: a toast, “Needs connection. Try again when you’re back online.” It comes back the moment the connection does. A button its page had disabled stays disabled.

**Use.** Add `mtNeedsConnection` to the button. Any callable that’s tried offline anyway fails at once with the same words, so a button without it still says why.

```html
<button mtButton variant="primary" mtNeedsConnection (click)="issue()">Issue invoice</button>
```
""", '<div class="mt-col" style="gap:12px">'
    + '<div class="mt-row" style="gap:12px">' + lab("online") + btn("Issue invoice", "primary") + btn("Run conflict check", "secondary", ic="search") + "</div>"
    + '<div class="mt-row" style="gap:12px">' + lab("offline") + btn("Issue invoice", "primary", state="disabled").replace("<button", '<button title="Needs connection"', 1)
    + btn("Run conflict check", "secondary", ic="search", state="disabled").replace("<button", '<button title="Needs connection"', 1)
    + '<span class="mt-tooltip">Needs connection</span></div>'
    + "</div>")

_steps = ('<ol class="mt-col" style="margin:0;padding:0;list-style:none;gap:14px;font:400 15px/22px var(--font-sans);color:var(--text-primary)">'
          + "".join(f'<li class="mt-row" style="gap:12px;align-items:flex-start"><span style="color:var(--icon-brand);margin-top:2px">{icon(ic)}</span><span>{text}</span></li>'
                    for ic, text in (("share", "Tap <b>Share</b> in Safari’s toolbar."),
                                     ("square-plus", "Scroll down and tap <b>Add to Home Screen</b>."),
                                     ("check", "Tap <b>Add</b>. Materia opens from your Home Screen like any other app.")))
          + "</ol>")

comp("InstallMateria", "Mobile", 400, """
# InstallMateria

Installing Materia as an app, offered where people look for it and never as a banner.

**Where.** “Install Materia” in the user menu and in ⌘K, only while the browser can install it (Chrome and Edge say so; an installed copy never sees it). On a phone it goes in the More tab (MOB-02). After installing, a toast says “Materia is installed” and where to find it.

**iOS.** Safari has no install prompt, so the same item opens the Add to Home Screen steps: a BottomSheet on a phone, a small Dialog on an iPad. Three steps, each with the icon the person will see in Safari.

The installed app opens at Today in its own window, with shortcuts to Today, New time entry and Record from its icon.
""", '<div class="mt-row" style="gap:24px;align-items:flex-start">'
    + '<div class="mt-menu" style="width:220px">' + menu_item("Profile", "user") + menu_item("Settings", "settings") + menu_item("Dark theme", "moon") + menu_item("Keyboard shortcuts", "keyboard", "?") + menu_item("Install Materia", "download", highlighted=True) + '<div class="mt-menu-sep"></div>' + menu_item("Sign out", "log-out") + "</div>"
    + '<div style="position:relative;width:390px;height:330px;border-radius:16px;overflow:hidden;background:var(--bg-canvas);border:1px solid var(--border-default)"><div class="mt-sheet"><span class="grab"></span><div class="title-m">Install Materia on this device</div>'
    + _steps + btn("Done", "primary", "lg").replace('class="mt-btn"', 'class="mt-btn" style="width:100%"') + "</div></div>"
    + "</div>", canvas=True)
