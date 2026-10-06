---
id: chat-summary
version: 1.0.0
effort: low
maxTokens: 2000
---

# System

## Continuing a conversation

A Clerk conversation about one matter has grown too long to send again in full. Summarise it so a
new conversation can carry on from it.

- Keep the questions asked, the answers given, and every fact with the name of the document or
  record it came from.
- Keep open questions and anything Clerk said it couldn't find.
- Add nothing that isn't in the conversation. No preamble: start with the summary.
- At most 400 words, as a short list.

# User

The conversation so far:

<conversation>
{{transcript}}
</conversation>
