# Table

Dense, scannable lists of matters, entries and documents: 40px rows, 13px text, group rows, and a sticky header.

Columns lead with the ref (mono) and status glyph, then the name, then type, stage, next deadline, owner and money (right-aligned, mono). Selected rows use `bg-selected`; selecting shows the bulk-action bar. Group rows (`.group`) collapse.

Use native `<table>` for semantics; selection follows `ngpListbox` keyboard patterns (↑ ↓, Space, Shift-click).
