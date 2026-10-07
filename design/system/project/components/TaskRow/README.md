# TaskRow

A to-do on Today or a matter: checkbox, title, the matter it belongs to, due date and owner.

Done tasks strike through in `text-tertiary`. Clerk-proposed tasks use Suggestion until accepted. Rows are 40px minimum.

**Snooze.** Where a row can be moved (Today's My tasks), a “Snooze to tomorrow” icon button shows on hover or focus, and always on touch screens. It moves the due date to tomorrow in the practice's time zone, with Undo in the toast.

**Swipe (phones).** Swipe right past 72px to finish the task and left to snooze it, each with Undo. The row follows the finger, says what letting go will do (“Done” on green, “Tomorrow” on amber) and springs back if it isn't far enough. Vertical scrolls, short drags and the mouse are left alone; with reduced motion the row doesn't animate back.
