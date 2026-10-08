"""The installable app's components (MOB-01): the update toast, Pending sync, Needs connection and the install steps; push alerts (MOB-04); and Help & feedback (SEC-08)."""
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
    + '<div class="mt-menu" style="width:220px">' + menu_item("Profile", "user") + menu_item("Settings", "settings") + menu_item("Dark theme", "moon") + menu_item("Keyboard shortcuts", "keyboard", "?") + menu_item("Help &amp; feedback", "help") + menu_item("Install Materia", "download", highlighted=True) + '<div class="mt-menu-sep"></div>' + menu_item("Sign out", "log-out") + "</div>"
    + '<div style="position:relative;width:390px;height:330px;border-radius:16px;overflow:hidden;background:var(--bg-canvas);border:1px solid var(--border-default)"><div class="mt-sheet"><span class="grab"></span><div class="title-m">Install Materia on this device</div>'
    + _steps + btn("Done", "primary", "lg").replace('class="mt-btn"', 'class="mt-btn" style="width:100%"') + "</div></div>"
    + "</div>", canvas=True)


def _offer(title, text, ic, action):
    return ('<section class="mt-row" style="width:560px;gap:12px;align-items:flex-start;padding:14px 16px;border:1px solid var(--border-subtle);border-radius:var(--radius-md);background:var(--bg-surface)">'
            + f'<span style="color:var(--icon-brand);margin-top:2px">{icon(ic)}</span>'
            + f'<div class="mt-col mt-grow" style="gap:2px"><p class="label" style="margin:0">{title}</p><p class="body-s t-2" style="margin:0">{text}</p></div>'
            + f'<div class="mt-row" style="gap:8px">{action}{btn("Not now", "ghost", "sm")}</div></section>')


_notification = ('<div class="mt-row" style="width:360px;gap:12px;align-items:flex-start;padding:12px 14px;border-radius:14px;background:var(--bg-raised);border:1px solid var(--border-default);box-shadow:var(--shadow-popover)">'
                 + '<span style="flex:none;width:32px;height:32px;border-radius:8px;background:var(--bg-brand);color:var(--text-on-brand);display:grid;place-items:center;font:600 15px/1 var(--font-sans)">M</span>'
                 + '<div class="mt-col mt-grow" style="gap:2px"><span class="caption t-3">Materia · now</span><span class="label">Critical deadline in 2 days: WE-142</span><span class="body-s t-2">Open Materia to see it.</span></div></div>')

comp("PushAlerts", "Mobile", 680, """
# PushAlerts

Push notifications on a device (MOB-04): deadline alerts, and the other notifications a person turns on for push, even when Materia is closed.

**Asking.** Never on sign-in. The first time someone looks at a critical deadline (on a matter’s Deadlines tab or the Deadlines page), a card under the list offers “Get deadline alerts on this device” with **Turn on alerts** and **Not now**. Only Turn on alerts asks the browser for permission. Either answer is remembered on the device and the card doesn’t come back; Settings → Preferences → Devices can turn push on at any time.

**iPhone and iPad.** Safari only delivers push to Materia on the Home Screen. In Safari the card says “Install Materia to receive alerts” and **How to install** opens the InstallMateria steps.

**Blocked.** When the browser has notifications blocked, Materia never asks again. The This device row says so and how to allow them again: the lock or settings icon beside the address, then Notifications, then reload.

**Devices.** Settings → Preferences → Devices: a This device row (Turn on, Turn off or How to install) and one row per device that gets push, named by browser and system (“Chrome on macOS”, “Materia app on iPhone”) with when it was last seen, **Send a test** and **Remove**. Devices unseen for 60 days stop getting pushes and drop off the list. Signing out removes this device.

**The notification.** The title names the matter by number at most; the text is always “Open Materia to see it.” Lock screens never show a client, a deadline’s title or anything else from the matter, which the in-app notification still has. Tapping it brings an open Materia tab forward at the link, or opens one. A notification from another practice asks first (“Switch to Harbour & Vine Legal?”, **Switch to Harbour & Vine Legal** and **Stay here**), because switching reloads Materia.
""", '<div class="mt-col" style="gap:24px">'
    + _offer("Get deadline alerts on this device", "Materia can tell this device when a critical deadline is close or nobody has acknowledged it, even when Materia is closed. Alerts name the matter number, never the client.", "bell", btn("Turn on alerts", "primary", "sm"))
    + _offer("Install Materia to receive alerts", "On iPhone and iPad, deadline alerts come only to Materia on your Home Screen. Install it, open it from there, and turn alerts on.", "smartphone", btn("How to install", "primary", "sm"))
    + '<div class="mt-settings-section" style="width:640px"><h3>Devices</h3><p>Where you get push notifications. Removing a device stops its pushes.</p>'
    + f'<div class="mt-setting"><div class="tx"><div class="tt">This device</div><div class="ts">Gets push notifications, even when Materia is closed.</div></div>{btn("Turn off", "secondary", "sm")}</div>'
    + f'<div class="mt-setting"><div class="tx"><div class="tt">Chrome on macOS (this device)</div><div class="ts">Last seen today</div></div><span class="mt-row" style="gap:8px">{btn("Send a test", "ghost", "sm")}{btn("Remove", "ghost", "sm")}</span></div>'
    + f'<div class="mt-setting"><div class="tx"><div class="tt">Materia app on iPhone</div><div class="ts">Last seen 3 days ago</div></div><span class="mt-row" style="gap:8px">{btn("Send a test", "ghost", "sm")}{btn("Remove", "ghost", "sm")}</span></div></div>'
    + _notification
    + "</div>", canvas=True)


def _kind(label, on=False):
    checked = ' aria-checked="true" data-checked' if on else ' aria-checked="false"'
    return f'<label class="mt-choice"><span class="mt-radio" role="radio" tabindex="0"{checked}></span><span>{label}</span></label>'


comp("HelpFeedback", "Actions", 560, """
# HelpFeedback

Help & feedback (SEC-08): where to read more, and a message to the people who run Materia. The same Dialog opens from the user menu (after Keyboard shortcuts), from ⌘K (“Help & feedback”) and from More on a phone, where it is a BottomSheet.

**Read more.** Links along the top: How Clerk works (only while Clerk is on), the accessibility statement and the legal pages. Following one closes the Dialog.

**The message.** What it is about (Something isn’t working, An idea, A question; the first is chosen) and the message, up to 4,000 characters. The description says what support sees: the person’s name, email and practice, and the page they were on (a path, never a query string). It asks them to leave out clients’ details.

**Sending.** Send keeps the message (`feedback-submit`) and emails support once a support address is set. The Dialog closes and a success toast says “Thanks. Your message was sent.” An empty message shows “Write a message”. Past ten in an hour: “You’ve sent a lot of messages in the last hour. Try again later.”, keeping what was written.

```ts
await account.openHelp();
```
""", '<div class="mt-dialog" role="dialog" aria-labelledby="help-t" style="width:520px"><div class="mt-dialog-h"><div class="mt-grow"><h2 id="help-t">Help &amp; feedback</h2><p>Tell the people who run Materia what isn’t working, what would help, or what you’d like to know.</p></div></div>'
    + '<div class="mt-dialog-b mt-col" style="gap:16px"><div class="mt-row" style="gap:16px;flex-wrap:wrap">'
    + "".join(f'<a class="label mt-row" style="gap:6px;color:var(--text-brand)">{icon(i)}{t}</a>' for i, t in [("sparkle", "How Clerk works"), ("document", "Accessibility"), ("shield", "Privacy and terms")])
    + '</div><div role="radiogroup" class="mt-col" style="gap:12px"><span class="mt-label">What is it about?</span>' + _kind("Something isn’t working", True) + _kind("An idea") + _kind("A question") + "</div>"
    + field("Message", placeholder="", help="Leave out clients’ details. Support sees your name, email and practice, and the page you were on.").replace('class="mt-input"', 'class="mt-input mt-textarea"')
    + '</div><div class="mt-dialog-f">' + btn("Cancel", "ghost") + btn("Send", "primary") + "</div></div>", canvas=True)
