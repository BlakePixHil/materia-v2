# Security policy

Materia holds confidential and legally privileged client information. We take reports seriously.

This policy is published with the app at `/SECURITY.md`, and `/.well-known/security.txt` ([RFC 9116](https://www.rfc-editor.org/rfc/rfc9116)) points to it and to the current contact.

## Reporting a vulnerability

- **If you can see this repository:** use GitHub's [private vulnerability reporting](https://github.com/BlakePixHil/materia-v2/security/advisories/new).
- **Otherwise:** email [blakelinnell96@gmail.com](mailto:blakelinnell96@gmail.com), the monitored security contact (also the `Contact` in [`/.well-known/security.txt`](https://materia-v2-prod.web.app/.well-known/security.txt)).

Please **do not** open a public issue, pull request or Linear ticket for a vulnerability, and do not include real client data in your report.

Include what you found, how to reproduce it, the impact you expect, and any suggested fix. We aim to acknowledge reports within 2 business days and to agree a disclosure timeline with you. We fix confirmed critical issues within 7 days and high ones within 30 days ([pentest plan](docs/security/pentest-plan.md)).

Good-faith research that follows this policy is welcome: test only against accounts and data you own, don't access, change or keep other people's information, don't degrade the service, and give us a reasonable time to fix an issue before you disclose it.

## Scope

This repository and the Materia v2 environments it deploys. The legacy app (`BlakePixHil/materia-web-app`) is being retired; report issues there to the owner too.

## Handling secrets

Secrets never go in code, Firestore or logs; they live in Google Secret Manager. If you find a committed secret, report it privately so it can be rotated, even if it looks inactive.
