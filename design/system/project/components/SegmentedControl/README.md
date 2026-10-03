# SegmentedControl

Switch the layout of the same data: List, Board or Timeline; Week, Month or FY.

Two to four items, each one word. Use icons with labels for view switches.

```html
<div ngpToggleGroup [(ngpToggleGroupValue)]="view" class="mt-seg"><button ngpToggleGroupItem value="list" class="mt-seg-item">List</button></div>
```
