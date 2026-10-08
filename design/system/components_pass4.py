"""Fourth-pass components (DES-01): Banner, Skeleton, NotificationRow, and IntegrationCard states."""
from components import C, comp, lab
from icons import icon
from markup import *


# ------------------------------------------------------------------ helpers shared with the pass-four screens
def banner(text, tone=None, ic="info", action=""):
    t = f' data-tone="{tone}"' if tone else ""
    role = ' role="alert"' if tone == "danger" else ' role="status"'
    return f'<div class="mt-banner"{t}{role}>{icon(ic)}<span class="mt-grow">{text}</span>{action}</div>'


def skel(w, h=None, shape=None, style=""):
    sh = f' data-shape="{shape}"' if shape else ""
    hh = f"height:{h}px;" if h else ""
    return f'<span class="mt-skel" data-static{sh} style="width:{w};{hh}{style}" aria-hidden="true"></span>'


NOTIF_ICON = {"mention": "at-sign", "assignment": "user-plus", "deadline": "clock", "overdue": "alert", "clerk": "sparkle", "email": "mail", "court": "court"}


def notif(kind, title, sub, when, unread=False, selected=False, side="", select=False):
    u = " data-unread" if unread else ""
    s = " data-selected" if selected else ""
    k = {"assignment": "", "email": "", "court": ""}.get(kind, kind)
    kd = f' data-kind="{k}"' if k else ""
    box = check("on" if selected else "off") if select else ""
    sel = " data-selectable" if select else ""
    dot = '<span class="dot"><span class="mt-sr">Unread</span></span>' if unread else '<span class="dot"></span>'
    return (f'<div class="mt-notif"{u}{s}{sel} role="listitem">{box}{dot}<span class="ic"{kd}>{icon(NOTIF_ICON[kind])}</span>'
            f'<div class="mt-grow"><div class="tt">{title}</div><div class="ts">{sub}</div></div><div class="side">{side}<span class="when">{when}</span></div></div>')


def day(label, n):
    return f'<div class="mt-notif-day">{icon("chevron-down", "sm")}<span class="t-1">{label}</span><span class="mt-count">{n}</span></div>'


def integration(mark, name, desc, state="connected", err=None, detail=None, action=None):
    st = {"connected": badge("Connected", "success"), "error": badge("Error", "danger"), "reconnect": badge("Reconnect needed", "warning"),
          "off": badge("Not connected"), "soon": badge("Not available yet")}[state]
    act = action if action is not None else {"connected": btn("Manage", "ghost", "sm"), "error": btn("Reconnect", "secondary", "sm", "refresh"),
                                             "reconnect": btn("Reconnect", "secondary", "sm", "refresh"), "off": btn("Connect", "secondary", "sm"), "soon": ""}[state]
    ds = ' data-state="error"' if state == "error" else ""
    e = f'<div class="mt-integration-error" role="alert">{icon("alert")}<span>{err}</span></div>' if err else ""
    d = f'<div class="caption t-3" style="margin-top:4px">{detail}</div>' if detail else ""
    return (f'<div class="mt-integration"{ds} style="align-items:flex-start"><span class="logo">{mark}</span><div class="mt-grow"><div class="mt-row" style="gap:8px"><span class="mt-integration-name mt-ell">{name}</span>{st}</div>'
            f'<div class="mt-integration-desc">{desc}</div>{d}{e}</div>{act}</div>')


# ------------------------------------------------------------------ catalogue
comp("Banner", "Feedback", 250, """
# Banner

A full-width strip under the top bar for a condition that affects the whole page: you are offline, your role is read-only, or a service the page depends on is failing. It is not for messages about one item (use Note) or for something that just happened (use Toast).

**Tones:** `warning` for offline and degraded service · default (info) for read-only and scheduled things · `danger` for a failure that blocks work · `neutral` for quiet context (“Viewing as Priya Shah”).

**Content.** Say what is happening and what still works, in one sentence: “You’re offline. Changes save on this device and sync when you reconnect.” One action at most, on the right (Retry, Request access).

**Behaviour.** Offline appears after 3 seconds without a connection and clears itself on reconnect with a “Back online” toast. Read-only stays for the whole session. `role="status"` for offline and read-only, `role="alert"` only for danger.

```html
<div class="mt-banner" data-tone="warning" role="status">…</div>
```
""", '<div class="mt-col" style="width:100%;gap:0;border:1px solid var(--border-default);border-radius:10px;overflow:hidden">'
    + banner("<b>You’re offline.</b> Changes save on this device and sync when you reconnect.", "warning", "wifi-off", btn("Retry", "ghost", "sm", "refresh"))
    + banner("<b>Read-only access.</b> You can view matters and documents. Ask an owner or admin to change your role.", None, "eye")
    + banner("<b>Xero isn’t responding.</b> Invoices you approve queue here and send when it’s back.", "danger", "alert", btn("Status", "ghost", "sm", "external"))
    + banner("Viewing settings as <b>Priya Shah</b> (lawyer).", "neutral", "user", btn("Stop", "ghost", "sm")) + "</div>", col=True)

comp("Skeleton", "Feedback", 300, """
# Skeleton

The loading state of a list, card or form: grey bars in the shape of the content that is coming, so the page doesn’t jump when it arrives. Use it for the first load of anything that takes longer than 300ms; refreshes keep the old content and show the 2px loading bar instead.

**Shape.** Match the real layout. `<mt-skeleton>` draws four shapes:

- `rows` (default): list and table rows: a 14px glyph, a ref bar (40px), a title bar (30–52% wide) and a trailing chip. `framed` draws the card when the loaded list sits in one. Six rows fill a table; never more than the screen holds.
- `lines`: a few lines of text for a small panel.
- `cards`: a grid of cards (a board, a matter’s overview).
- `fields`: a settings form, with the title and description on the left and the control on the right.

**Motion.** It waits 150ms before fading in, so a fast load never flashes it, then shimmers slowly (1.6s). The shimmer is a highlight moved with `transform`, so it runs on the compositor and costs the main thread nothing while a slow load waits (MOB-02b). The content that replaces it fades in. No shimmer and no fade with `prefers-reduced-motion`.

**Accessibility.** The skeleton is a polite `role="status"` with a visually hidden label (“Loading matters…”); the bars are hidden from screen readers. Where several skeletons draw one region, only the first has a label.

```html
<mt-skeleton framed label="Loading matters…" [count]="6" />
<mt-skeleton variant="fields" framed label="Loading settings…" />
```
""", '<div class="mt-col" style="width:100%;gap:16px">'
    + '<div class="mt-skeleton" data-framed role="status"><span class="mt-sr">Loading matters</span>'
    + "".join(f'<div class="row" aria-hidden="true">{skel("14px", 14, "circle")}{skel("40px")}{skel(w)}{skel("72px", shape="chip")}</div>' for w in ("48%", "36%", "52%"))
    + "</div>"
    + '<div class="mt-row" style="gap:16px;align-items:flex-start">'
    + '<div class="mt-skeleton" data-variant="fields" data-framed aria-hidden="true" style="flex:1">'
    + "".join(f'<div class="row"><span class="tx">{skel(w)}{skel("55%")}</span>{skel("120px", 28)}</div>' for w in ("28%", "36%"))
    + "</div>"
    + '<div class="mt-skeleton" data-variant="lines" aria-hidden="true" style="flex:1">' + "".join(skel(w) for w in ("92%", "78%", "85%")) + "</div>"
    + "</div></div>", col=True)

comp("NotificationRow", "Feedback", 300, """
# NotificationRow

One item in the Inbox or the notifications popover: who or what, the matter, and when. Unread rows carry a blue dot and primary text; read rows drop to secondary.

**Kinds** set the glyph: `mention` (@), `assignment` (person), `deadline` (clock, amber), `overdue` (red), `clerk` (violet sparkle, for finished Clerk work), `email` (unfiled mail) and `court` (orders and listings).

**Content.** Bold the actor and the object: “**Priya Shah** mentioned you on **WE-142**”. The second line is the matter and the snippet. Time is relative under a day (“9:14 am”), then the weekday, then the date.

**Behaviour.** `Enter` opens the item and marks it read; `E` marks read without opening; `X` selects for bulk actions. Rows group under day headers (Today, Yesterday, then the weekday).
""", '<div class="mt-card" style="width:100%;overflow:hidden" role="list">' + day("Today", 3)
    + notif("mention", "<b>Priya Shah</b> mentioned you on <b>WE-142 · Estate of Margaret Whitfield</b>", "“@Jordan can you check the asset schedule before I send it?”", "9:14 am", True)
    + notif("deadline", "<b>Publish notice of intended application</b> is due today", "WE-142 · A&amp;P Rules 2014 · 14 days before filing", "7:30 am", True)
    + notif("clerk", "<b>Clerk</b> drafted 6 time entries from yesterday", "2.1 h to review · nothing bills until you accept", "7:02 am", False) + "</div>", col=True)

# IntegrationCard gains its states: replace the second-pass preview.
_ic = next(c for c in C if c["name"] == "IntegrationCard")
_ic["readme"] = """# IntegrationCard

A connected service: its mark (supplied by the service; a monogram until then), what materia uses it for, its status and one action.

**States.** `Connected` (green badge, Manage) · `Reconnect needed` (amber: the sign-in expired, nothing is lost) · `Error` (red border and badge, with the provider’s reason in full, wrapped, and Reconnect) · `Not connected` (Connect) · `Not available yet` (no action).

Errors say what failed, what is affected and how to fix it, and wrap onto as many lines as they need: never truncate an error.
"""
_ic["height"] = 330
_ic["body"] = ('<div class="mt-col" style="width:560px;gap:8px">'
               + integration("M", "Microsoft 365", "Email filing, calendar sync and time capture", "connected", detail="jordan.price@haleprice.example.com.au · since 4 Aug")
               + integration("G", "Google Workspace", "Gmail filing and Google Calendar", "reconnect", detail="Signed out 3 Oct when the password changed. Filing paused; nothing is lost.")
               + integration("X", "Xero", "Invoices and payments", "error", err="Xero refused the connection: the organisation’s subscription has lapsed, or an adviser removed materia’s access. Reconnect with a Xero user who has the Standard role or above.")
               + "</div>")
