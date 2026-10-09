# TabBar

Primary navigation on phones (under 768px): Today, Matters, Record, Inbox and More. The centre item is the Record screen (log time or a file note, and voice when it ships), raised as a 48px button labelled “Record” for screen readers. Inbox carries its unread count. More holds the rest of the sidebar, your account and the theme; any page reached from it keeps More current.

Fixed to the bottom with the safe area below it, the same height from the first frame (no layout shift). Targets are at least 44px. The page keeps scroll padding for it and the sticky top bar, so scrolling to a control (focus, a #link) stops clear of both.
