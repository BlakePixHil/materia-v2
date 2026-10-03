# Select

Choose one value from a short, known list (matter type, jurisdiction, fee arrangement). Use a Combobox (searchable) for long lists such as people and matters.

The trigger looks like a TextField with an `updown` chevron. Open state uses the focus treatment. Options render in a Menu with a check on the selected item.

```html
<div ngpSelect [(ngpSelectValue)]="type" class="mt-input mt-select">…</div>
<div *ngpSelectPortal ngpSelectDropdown class="mt-menu"><div ngpSelectOption value="probate" class="mt-menu-item">Probate</div></div>
```
