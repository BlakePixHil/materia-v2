# Tabs

Switch between views of one object (a matter’s Overview, Deadlines, Estate, Parties, Documents, Time). Not for primary navigation.

The active tab gets a 2px `bg-brand` underline. Counts use `mt-count`. Keep labels to one word where possible.

```html
<div ngpTabset><div ngpTabList class="mt-tabs"><button ngpTabButton ngpTabButtonValue="overview" class="mt-tab">Overview</button></div></div>
```
