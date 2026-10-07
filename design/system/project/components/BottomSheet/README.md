# BottomSheet

The phone’s dialog: slides up over the current screen for a short task (record time, confirm a deadline). Grab handle, a title, the content, and the primary action at the bottom within thumb reach.

Under 768px every Dialog takes this shape by itself (`libs/ui` dialog CSS), so features don't build a second version. It rises above the on-screen keyboard (`--mt-keyboard-inset`), scrolls inside when it's taller than the screen, and closes with the Close button, Esc or a tap on the overlay.
