# NeedsConnection

A button whose action only the server can do (issue an invoice, run a conflict check, generate a document, send an invite) while the browser is offline. Everything that saves on the device keeps working; these can’t.

**Look.** The button is disabled but stays focusable, and its title reads “Needs connection”. Clicking it explains instead of doing nothing: a toast, “Needs connection. Try again when you’re back online.” It comes back the moment the connection does. A button its page had disabled stays disabled.

**Use.** Add `mtNeedsConnection` to the button. Any callable that’s tried offline anyway fails at once with the same words, so a button without it still says why.

```html
<button mtButton variant="primary" mtNeedsConnection (click)="issue()">Issue invoice</button>
```
