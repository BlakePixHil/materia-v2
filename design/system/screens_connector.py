"""The Claude connector (INT-07, ADR-064): Settings → Claude connector and the consent page Claude opens. Composed from catalogue components only."""
from icons import icon
from markup import *
from screens_next import logo_mark, setting
from screens_settings import page_head, sec, settings_frame

URL = "https://app.haleprice.example.com.au/mcp"


def _row(title, sub, action):
    return setting(title, sub, action)


# ------------------------------------------------------------------ Settings: Claude connector
def claude_settings():
    steps = ('<ol class="body-s t-2" style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px">'
             "<li>In Claude, open <b>Settings → Connectors</b> and choose <b>Add custom connector</b>.</li>"
             "<li>Name it materia, paste the address above and choose <b>Add</b>.</li>"
             "<li>Choose <b>Connect</b>, sign in to materia and allow Claude.</li></ol>")
    address = (f'<div class="mt-row mt-wrap" style="gap:8px;padding:8px 8px 8px 12px;border:1px solid var(--border-default);border-radius:var(--radius-md);background:var(--bg-subtle)">'
               f'<span class="mono mt-grow">{URL}</span>{btn("Copy", "secondary", "sm", "copy")}</div>')
    note = ('<div class="mt-note">' + icon("shield") + "<span>Connect the Claude account the practice gave you (Team or Enterprise), not a personal one. "
            "Privileged matters and the text of documents are never shared, and every request is in the audit log.</span></div>")
    disclosure = ('<div class="mt-note">' + icon("info") + "<span>What people read through Claude goes into their own Claude account and is processed by Anthropic outside Australia, "
                  "under that account’s terms. Ask them to use the practice’s Claude Team or Enterprise accounts, not personal ones.</span></div>")
    body = ('<div class="mt-col" style="gap:28px;max-width:760px">'
            + page_head("Claude connector", "Use materia from your own Claude: ask about your matters, deadlines, tasks and time, and have Claude suggest tasks, file notes and time entries that someone accepts here.")
            + sec("For the practice", "Off until you turn it on. Turning it off ends every connection at once.", [
                _row("Let people connect Claude", "Each person connects their own Claude account, and it sees only what they can see in materia.", switch(True)),
                _row("Let Claude suggest changes", "Tasks, file notes and time entries wait on the matter until someone accepts them. When off, Claude only reads.", switch(True)),
                disclosure])
            + sec("Connect Claude", "Add materia to Claude once. Claude then asks you to sign in here and allow it.", [
                f'<div class="mt-col" style="gap:12px">{address}{steps}<span class="caption t-3">In Claude Code, run <span class="mono">claude mcp add --transport http materia {URL}</span>, then <span class="mono">/mcp</span> to sign in.</span>{note}</div>'])
            + sec("Your connections", "", [
                _row("Claude", "Connected 6 Oct 2026 · last used 7 Oct 2026 · Read your matters, Suggest changes", btn("Disconnect", "ghost", "sm"))])
            + sec("Everyone’s connections", "End anyone’s connection at once, for example when a laptop is lost. They can connect again.", [
                _row("Priya Shah · Claude", "Connected 2 Oct 2026 · last used 7 Oct 2026 · Read your matters, Suggest changes", btn("Disconnect", "ghost", "sm")),
                _row("Daniel Kim · Claude Code", "Connected 29 Sep 2026 · last used 5 Oct 2026 · Read your matters", btn("Disconnect", "ghost", "sm"))])
            + "</div>")
    return settings_frame("Claude connector", body)


# ------------------------------------------------------------------ Connect Claude (consent)
def connect_claude():
    scope = lambda ic, t, d, n="": (f'<li class="mt-row" style="gap:12px;align-items:flex-start"><span style="flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:var(--radius-md);background:var(--bg-subtle);color:var(--text-secondary)">{icon(ic)}</span>'
                                    f'<span class="mt-col" style="gap:2px"><b class="label">{t}</b><span class="caption t-2">{d}</span>{n}</span></li>')
    scopes = ('<ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px">'
              + scope("eye", "Read your matters", "Matters you can see, with their deadlines, tasks and time totals. Never privileged matters or the text of documents.")
              + scope("sparkle", "Suggest changes", "Suggest tasks, file notes and time entries. Each one waits on the matter as a suggestion until someone accepts it in materia.")
              + "</ul>")
    card = ('<div class="mt-col" style="width:440px;gap:16px;padding:32px;border-radius:var(--radius-xl);border:1px solid var(--border-default);background:var(--bg-surface);box-shadow:var(--shadow-card)">'
            '<div class="mt-col" style="gap:6px"><h1 class="title-m" style="margin:0">Allow Claude to use materia?</h1>'
            '<p class="body t-2" style="margin:0">Claude will work as you, Priya Shah, in Hale &amp; Price. It can:</p></div>'
            '<p class="caption t-3" style="margin:0">Asked by claude.ai</p>'
            + scopes
            + '<div class="mt-note">' + icon("info") + "<span>What Claude reads leaves materia and is processed by Anthropic outside Australia, under your Claude account’s terms. Privileged matters and the text of documents are never shared.</span></div>"
            + '<p class="caption t-3" style="margin:0">Every request is in the practice’s audit log. Disconnect at any time in Settings → Claude connector; signing out everywhere or leaving the practice disconnects it too.</p>'
            + '<div class="mt-row" style="gap:8px">' + btn("Allow", "primary") + btn("Cancel", "ghost") + "</div></div>")
    return (f'<div class="mt" style="width:1440px;min-height:900px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:24px 16px;background:var(--bg-canvas)">'
            f'<div class="mt-row" style="gap:10px">{logo_mark()}<span style="font:600 17px/1 var(--font-sans);letter-spacing:-.02em">materia</span></div>{card}'
            '<nav class="mt-row caption t-3" style="gap:16px"><span>Privacy policy</span><span>Terms of service</span><span>Collection notice</span></nav></div>')


SCREENS = [
    ("Settings: Claude connector", "INT-07: owners and admins turn the connector and its suggestions on; everyone copies the address into Claude and sees and ends their own connections; owners and admins end anyone’s.", claude_settings),
    ("Connect Claude", "INT-07: the consent page Claude opens. What Claude can do as this person, what it never sees, where the data goes, then Allow or Cancel.", connect_claude),
]
