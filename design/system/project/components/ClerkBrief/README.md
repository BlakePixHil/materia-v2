# ClerkBrief

Clerk’s proactive summary card: a heading that states the conclusion, up to three items, each with its sources and one action.

The card has a 2px violet-to-orange top edge, `border-ai` and `ai-glow`. Each item leads with the matter name in bold, says what changed and what Clerk did, and cites its sources with `mt-cite`. The footer states what Clerk read and when. Use it on Today and at the top of a matter, never more than once per page.

At the top of a matter's Overview it is the matter brief (AI-06c): a heading with the day's numbers, then at most five items, what's overdue or due in the next 14 days first, then what changed and one next step. Each item leads with what it is ("Overdue.", "Due soon.", "New since your last visit.", "Next step."), and cites the deadline, task, document, note or suggestion it is about with numbered `mt-cite` chips that open that record. The head carries Refresh and, where the Clerk panel is available, "Ask a follow-up". When Clerk didn't write it (Clerk is off, it failed, or the person can't use Clerk), the same card shows the template brief built from the same facts, in the plain style: `data-plain` drops the AI edge, glow and wash, the head shows "Matter brief" without the Clerk mark, and the footer says it was built from the matter's records. While it loads, the card holds `mt-skeleton` lines.
