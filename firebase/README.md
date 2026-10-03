# firebase

Firebase configuration for Materia v2. Run the CLI with `--config firebase/firebase.json`, or use the root scripts (`pnpm emulators`).

| File                               | Owner ticket                                                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `firebase.json`                    | Functions codebase `core` (built to `dist/apps/functions`), Hosting (`dist/apps/web/browser`), and emulator ports                                                                                     |
| `.firebaserc`                      | Project aliases. `default` is the offline `demo-materia` emulator project; the `dev`, `staging` and `prod` ids are placeholders until FND-03 provisions the projects (in MVP mode, dev and prod only) |
| `firestore.rules`, `storage.rules` | Deny-all placeholders until FND-14                                                                                                                                                                    |
| `firestore.indexes.json`           | Empty until FND-14                                                                                                                                                                                    |
