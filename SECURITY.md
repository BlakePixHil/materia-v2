# Security policy

Materia holds confidential and legally privileged client information. We take reports seriously.

## Reporting a vulnerability

- **Preferred:** use GitHub's [private vulnerability reporting](https://github.com/BlakePixHil/materia-v2/security/advisories/new) for this repository.
- **Otherwise:** contact the repository owner directly and privately.

Please **do not** open a public issue, pull request or Linear ticket for a vulnerability, and do not include real client data in your report.

Include what you found, how to reproduce it, the impact you expect, and any suggested fix. We aim to acknowledge reports within 2 business days and to agree a disclosure timeline with you.

## Scope

This repository and the Materia v2 environments it deploys. The legacy app (`BlakePixHil/materia-web-app`) is being retired; report issues there to the owner too.

## Handling secrets

Secrets never go in code, Firestore or logs; they live in Google Secret Manager. If you find a committed secret, report it privately so it can be rotated, even if it looks inactive.
