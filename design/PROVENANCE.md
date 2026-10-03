# Provenance

This folder was copied from the legacy repository `BlakePixHil/materia-web-app`, branch `claude/dazzling-lovelace-7nln12`, commit `217f62c1b6bc040b81186fcefa847a05a8249584` (2026-10-03), in ticket FND-01.

It is a plain copy, without the file history: that history lives in the legacy repository at the commit above.

Changes made on import:

- The four logo SVGs from the legacy app's `src/assets/logos/` now live in `design/assets/logos/`.
- `system/build.py` and `system/screens_next.py` read logos from `design/assets/logos/` instead of the legacy `src/assets/logos/`.

`python3 design/system/build.py` regenerates the committed output byte for byte (checked on import with `git status`).
