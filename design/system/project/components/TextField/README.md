# TextField

A labelled single-line input with optional helper or error text; the default control for intake forms.

**Anatomy:** label (13px medium, above) → control (32px, `border-control`, `radius-sm`) → helper (12px, `text-tertiary`) or error (12px, `text-danger`, with the `alert` icon).

**States:** rest · hover (`data-hover`) · focus (`data-focus`: `border-focus` + 3px tint) · invalid (`data-invalid`) · disabled (`data-disabled`).

**Writing.** Labels name the thing (“Date of death”), not an instruction. Helpers say where the value comes from. Errors say what’s wrong and how to fix it: “That date doesn’t exist. Check the death certificate.” Never “Invalid input”.

**Formats.** Dates are entered `DD/MM/YYYY` and displayed `22 Jul 2026`. Currency is AUD with a suffix and no symbol in the field.

```html
<div ngpFormField class="mt-field">
  <label ngpLabel class="mt-label">Date of death</label>
  <span class="mt-input"><input ngpInput formControlName="dateOfDeath" /></span>
  <p ngpDescription class="mt-help">As shown on the death certificate.</p>
  <p ngpError class="mt-error">…</p>
</div>
```
