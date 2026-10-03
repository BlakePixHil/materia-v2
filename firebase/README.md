# firebase

Firebase configuration for Materia v2. Run the CLI with `--config firebase/firebase.json`, or use the root scripts (`pnpm emulators`).

| File                               | Owner ticket                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `firebase.json`                    | Functions codebase `core` (built to `dist/apps/functions`), Hosting (`dist/apps/web/browser`), and emulator ports                                                                                                                                                        |
| `.firebaserc`                      | Project aliases. `default` is the offline `demo-materia` emulator project; `dev` and `prod` are the project ids planned in `infra/terraform/envs/*.tfvars` (FND-03); `staging` is deferred in MVP mode. If a suffix is needed because an id is taken, change it here too |
| `firestore.rules`, `storage.rules` | Deny-all placeholders until FND-14                                                                                                                                                                                                                                       |
| `firestore.indexes.json`           | Empty until FND-14                                                                                                                                                                                                                                                       |
