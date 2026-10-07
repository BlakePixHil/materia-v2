# Switch

Settings that take effect immediately (Clerk suggestions on/off, calendar sync). Use a Checkbox inside forms that are saved with a button.

On phones (under 768px) it is iOS-sized: a 51 × 31px track with a 27px thumb, inside a 44px-tall target whose border above and below is clear. Its label centres on the track, and the focus ring hugs the track. Set its colours with `background-color`, never the `background` shorthand, which would fill the clear border.

```html
<button ngpSwitch [(ngpSwitchChecked)]="enabled" class="mt-switch"><span ngpSwitchThumb class="mt-switch-thumb"></span></button>
```
