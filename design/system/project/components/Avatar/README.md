# Avatar

People, organisations and Clerk. Initials fall back over a photo; hues cycle through brand, info, warning and success subtle tints by a stable hash of the person’s id.

Sizes: xs 18 · sm 20 · md 24 · lg 32 · xl 40. Clerk is the only avatar with the violet-to-orange gradient; never use that gradient for anything else. Firms use `data-kind="org"` (rounded square).

```html
<span ngpAvatar class="mt-avatar"><img ngpAvatarImage [src]="photo" /><span ngpAvatarFallback>JP</span></span>
```
