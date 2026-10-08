# HelpFeedback

Help & feedback (SEC-08): where to read more, and a message to the people who run Materia. The same Dialog opens from the user menu (after Keyboard shortcuts), from ⌘K (“Help & feedback”) and from More on a phone, where it is a BottomSheet.

**Read more.** Links along the top: How Clerk works (only while Clerk is on), the accessibility statement and the legal pages. Following one closes the Dialog.

**The message.** What it is about (Something isn’t working, An idea, A question; the first is chosen) and the message, up to 4,000 characters. The description says what support sees: the person’s name, email and practice, and the page they were on (a path, never a query string). It asks them to leave out clients’ details.

**Sending.** Send keeps the message (`feedback-submit`) and emails support once a support address is set. The Dialog closes and a success toast says “Thanks. Your message was sent.” An empty message shows “Write a message”. Past ten in an hour: “You’ve sent a lot of messages in the last hour. Try again later.”, keeping what was written.

```ts
await account.openHelp();
```
