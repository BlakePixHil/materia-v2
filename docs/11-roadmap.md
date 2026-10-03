# Roadmap & release phases

The phases are ordered by dependency, not by date. Velocity is unknown, so we'll set dates after M0.1 lands.

| Phase | Includes | Exit |
|---|---|---|
| **Phase 0: Foundations** | Project 00 (M0.1 → M0.3) | Pipeline green; sign in, create an org and invite someone in staging; UI library complete in Storybook |
| **Phase 1: Internal alpha** | 01 M1.1 + M1.2, 02 M2.1, 03 M3.1, 09 SEC-01/02/03 started | The team runs fictional probate matters end to end in staging |
| **Phase 2: Migration beta** | 01 M1.3, 02 M2.2, 03 M3.2, 07 (all), 09 M9.1, 06 M6.1 | The legacy user is migrated to prod and works daily in v2. Legacy is read-only |
| **Phase 3: Litigation & AI depth** | 04 (all), 03 M3.3, 05, 06 M6.2 | Contested-estate matters managed fully in v2 |
| **Phase 4: Mobile & GA** | 08, 09 M9.2 | Launch checklist complete, with the a11y and perf audits passed |

## Critical path

`FND-01 → FND-02 → FND-04 → FND-05`, with FND-03 running in parallel. Then `FND-13 → FND-14 → FND-15 → FND-11 → FND-12`, then `CORE-*`. After that, `MIG-*` can proceed once CORE-03, CORE-08, CORE-12 and CORE-13 exist, because the migration targets those entities.

## Parallelism for agents

Once FND-02, FND-13 and FND-07 are done, these streams can run in parallel without blocking each other:
- the UI library (FND-08a–e);
- the deadline engine (CORE-09);
- migration export and transform (MIG-01 to MIG-03), since transforms only need `libs/domain`;
- the Clerk spike (AI-01);
- the compliance docs (SEC-01).
