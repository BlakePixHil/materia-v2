# Skeleton

The loading state of a list or card: grey bars in the shape of the content that is coming, so the page doesn’t jump when it arrives. Use it for the first load of anything that takes longer than 300ms; refreshes keep the old content and show the 2px loading bar instead.

**Shape.** Match the real layout: a 14px glyph square, a ref bar (40px), a title bar (40–60% wide), chips as 20px blocks. Six rows fill a table; never more than the screen holds.

**Motion.** A slow shimmer (1.6s); none with `prefers-reduced-motion`. The region has `aria-busy="true"` and a visually hidden “Loading matters” label.
