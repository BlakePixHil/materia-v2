# NotificationRow

One item in the Inbox or the notifications popover: who or what, the matter, and when. Unread rows carry a blue dot and primary text; read rows drop to secondary.

**Kinds** set the glyph: `mention` (@), `assignment` (person), `deadline` (clock, amber), `overdue` (red), `clerk` (violet sparkle, for finished Clerk work), `email` (unfiled mail) and `court` (orders and listings).

**Content.** Bold the actor and the object: “**Priya Shah** mentioned you on **WE-142**”. The second line is the matter and the snippet. Time is relative under a day (“9:14 am”), then the weekday, then the date.

**Behaviour.** `Enter` opens the item and marks it read; `E` marks read without opening; `X` selects for bulk actions. Rows group under day headers (Today, Yesterday, then the weekday).
