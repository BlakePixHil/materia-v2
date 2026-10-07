"""Guided tours (CORE-24): the theatre-mode overlay that walks a page one feature at a time."""
from components import comp
from markup import *


def card(eyebrow, title, body, foot, dots=None, intro=False, style=""):
    d = ""
    if dots:
        n, on = dots
        d = '<span class="mt-tour-dots" aria-hidden="true">' + "".join("<i data-on></i>" if i == on else "<i></i>" for i in range(n)) + "</span>"
    i = " data-intro" if intro else ""
    return (f'<section class="mt-tour-card" data-placed role="dialog" aria-label="{title}"{i} style="position:relative;top:auto;left:auto;{style}">'
            + ibtn("x", "End tour", size="sm").replace('class="mt-ibtn"', 'class="mt-ibtn mt-tour-close"')
            + f'<div class="mt-tour-step"><span class="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{body}</p></div>'
            + f'<div class="mt-tour-foot">{d}{foot}</div></section>')


comp("Tour", "Overlays", 520, """
# Tour

A guided tour in “theatre” mode: the page dims, a spotlight sits on one feature, and a card beside it says what it is for and how to use it, in a sentence or two. Back and Next walk the page; the dots show how far through you are.

**When it shows.** The welcome tour opens on your first sign-in, with **Show me around** and **Skip**. Taking it walks the sidebar, search, the timer, Clerk and Settings, and turns *page tours* on: each main page (Today, Matters, a matter, Documents, Time, Time and billing, Settings) then plays its own tour the first time you open it. Skipping leaves them off. Either answer is kept on your profile, so it follows you to every device. Start a page's tour any time with ⌘K “Tour this page” or <kbd>⇧H</kbd>; Settings → Preferences → Guided tours turns page tours on or off and replays them.

**Placement.** The card sits below its feature, or above, right or left, whichever fits, and never leaves the screen. Features scroll into view first. A step whose feature isn’t on this screen (a phone has no sidebar) is left out; a step with no feature shows the card in the middle. On a phone the card docks to the bottom edge (the top when the feature is low on the screen), full width.

**Motion.** The overlay fades in over `motion-slow`. Between steps the spotlight glides to the next feature and the card follows (`motion-slow`, `ease-in-out`) while its words rise in. Leaving fades over `motion-base`. With reduced motion everything simply appears.

**Accessibility.** The card is a modal dialog: focus moves into it and stays there (the page behind is `inert`), **Escape** ends the tour, **←** and **→** step, and focus goes back where it was. Each step is announced (“Step 2 of 5. Your workspace. …”).

**Copy.** Plain words and the practice’s own examples: “Probate for the Estate of Margaret Doyle”, “a Geelong client”. Titles name the feature; bodies say what you’d use it for. At most two sentences.

```ts
// A page's tour is data: steps point at `data-tour` attributes on the page.
{ id: 'billing', title: 'Time and billing', match: /^\\/billing$/, steps: [
  { target: '[data-tour="billing-stats"]', title: 'Your week at a glance', body: '…' },
] }
```
""", '<div class="mt-col" style="gap:20px;align-items:flex-start">'
    + card("Welcome to Materia", "Let’s show you around", "A one-minute tour of where things live: your day, your matters, the timer and Clerk. You can take it again any time from Settings.",
           btn("Skip", "ghost", "sm") + btn("Show me around", "primary", "sm"), intro=True)
    + card("Today · 2 of 5", "Needs your attention", "Overdue tasks and deadlines due this week, across all your matters. The grant of probate filing for the Doyle estate would show here the week it falls due.",
           btn("Back", "ghost", "sm") + btn("Next", "primary", "sm"), dots=(5, 1))
    + "</div>", canvas=True)
