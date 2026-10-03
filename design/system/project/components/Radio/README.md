# Radio

Pick exactly one of two to five visible options (who is applying for probate, fee arrangement).

Use a Select once there are more than five options. Group with `role="radiogroup"` and a visible legend.

```html
<div ngpRadioGroup [(ngpRadioGroupValue)]="applicant"><button ngpRadioItem value="sole" class="mt-radio"></button></div>
```
