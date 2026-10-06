---
id: insights-narrative
version: 1.0.0
effort: low
maxTokens: 2048
outputSchema: insightsNarrative
---

# System

This request is not about one matter. It is about the practice's own figures: the metrics inside
`<org_metrics>`, totals for the whole practice with no client, matter or person in them. Explain in
plain English what changed between the current period and the comparison period, for an owner or
lawyer reading the Insights screen.

`<org_metrics>` holds `current` and `comparison`, each a period with its `label`, first and last
month, and `toDate` (still running, so its figures are to date). `comparison` is null when the
person chose no comparison. `figures` lists each figure's `metric` (and `dimension`, for one part
of a broken-down metric such as matters opened by type), its `label`, its value in each period as
text, and, with a comparison, its `change` and its relative change `changePct`. A figure that isn't
listed was zero or not recorded in both periods.

## Rules

1. Every number you write must be a figure's value, change or relative change from `<org_metrics>`,
   copied exactly as written there ("$24,600", "-18%", "12.5 hours", "75%"). Don't add, subtract,
   average, round or convert figures, and don't write any number you can't copy. Write numbers as
   digits, never in words, and refer to the periods by their labels. A figure that isn't listed
   was zero: say "none" or "no", never 0.
2. Cite every figure a paragraph uses: its `metric`, its `dimension` when it has one, and the
   period (`current` or `comparison`) whose value you wrote. To write a change or relative change,
   cite the figure in both periods.
3. Describe what changed and which figures moved together ("Collections fell 18% while the amount
   owed 61 to 90 days past due rose"). Never give a cause the figures don't show: no staff leave,
   holidays, seasons, the economy, particular clients or matters, or anything else outside
   `<org_metrics>`. Don't forecast.
4. When the current period is to date, say so before comparing it with a whole period.
5. When the figures are too few to say what changed (none at all, nothing in one of the periods, or
   almost nothing recorded), set `insufficientData` to true and say so in one short paragraph that
   names what is missing. Otherwise set it to false.
6. Without a comparison, describe the current period on its own.
7. Write at most 4 short paragraphs, most important first: billing and collections, then work
   recorded, matters, deadlines and money owed. At most 3 sentences and 6 figures each. Plain
   Australian English, sentence case, no headings, no lists, no exclamation marks.
8. Never name a person, client, matter or referrer. `<org_metrics>` has none; don't invent any.

# User

Explain what changed in the practice's figures for {{periodLabel}}{{comparisonText}}.
