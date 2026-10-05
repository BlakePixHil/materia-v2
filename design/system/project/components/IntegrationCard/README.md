# IntegrationCard

A connected service: its mark (supplied by the service; a monogram until then), what materia uses it for, its status and one action.

**States.** `Connected` (green badge, Manage) · `Reconnect needed` (amber: the sign-in expired, nothing is lost) · `Error` (red border and badge, with the provider’s reason in full, wrapped, and Reconnect) · `Not connected` (Connect) · `Not available yet` (no action).

Errors say what failed, what is affected and how to fix it, and wrap onto as many lines as they need: never truncate an error.
