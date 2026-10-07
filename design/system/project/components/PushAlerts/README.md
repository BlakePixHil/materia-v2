# PushAlerts

Push notifications on a device (MOB-04): deadline alerts, and the other notifications a person turns on for push, even when Materia is closed.

**Asking.** Never on sign-in. The first time someone looks at a critical deadline (on a matter’s Deadlines tab or the Deadlines page), a card under the list offers “Get deadline alerts on this device” with **Turn on alerts** and **Not now**. Only Turn on alerts asks the browser for permission. Either answer is remembered on the device and the card doesn’t come back; Settings → Preferences → Devices can turn push on at any time.

**iPhone and iPad.** Safari only delivers push to Materia on the Home Screen. In Safari the card says “Install Materia to receive alerts” and **How to install** opens the InstallMateria steps.

**Blocked.** When the browser has notifications blocked, Materia never asks again. The This device row says so and how to allow them again: the lock or settings icon beside the address, then Notifications, then reload.

**Devices.** Settings → Preferences → Devices: a This device row (Turn on, Turn off or How to install) and one row per device that gets push, named by browser and system (“Chrome on macOS”, “Materia app on iPhone”) with when it was last seen, **Send a test** and **Remove**. Devices unseen for 60 days stop getting pushes and drop off the list. Signing out removes this device.

**The notification.** The title names the matter by number at most; the text is always “Open Materia to see it.” Lock screens never show a client, a deadline’s title or anything else from the matter, which the in-app notification still has. Tapping it brings an open Materia tab forward at the link, or opens one. A notification from another practice asks first (“Switch to Harbour & Vine Legal?”, **Switch to Harbour & Vine Legal** and **Stay here**), because switching reloads Materia.
