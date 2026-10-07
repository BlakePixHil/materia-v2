# AppUpdate

How a new version of Materia reaches an open tab. Materia checks a minute after it starts, every 30 minutes while it’s visible, and when you come back to a tab left for half an hour.

**New version.** A toast that stays until it’s used: “New version available”, “Reload to start using it. Anything you’ve saved stays as it is.”, and Reload. Reload moves every open tab to the new version together, after any changes saved on this device have synced (10 seconds at most).

**Too old to keep working.** When the API has moved past this copy (`system-ping` returns a `minClientVersion` above the build’s), a Dialog asks once: “Reload to keep working”, with **Reload now** and **Save my work first**. Saving first leaves a toast with Reload that stays until it’s used. Never reload on its own: a half-filled form would be lost.
