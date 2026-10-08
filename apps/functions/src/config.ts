/** Every regional Firebase/GCP resource runs in Sydney (Architecture & ADRs, ADR-003). */
export const REGION = 'australia-southeast1' as const;

/**
 * Each project's own addresses besides its Firebase ones: `custom_domain` in
 * `infra/terraform/envs/<env>.tfvars`. The Claude connector answers on each as its own issuer.
 */
export const CUSTOM_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  'materia-v2-dev': ['dev.materia.au'],
};

/**
 * The From address of every email (FND-20). Replace the placeholder with an address on the domain
 * Resend has verified (infra/MANUAL.md, "Email: Resend"); `.example` addresses are never deliverable.
 */
export const MAIL_FROM = 'Materia <notifications@materia.example>';

/**
 * Where Help & feedback is emailed (SEC-08). Empty until the support mailbox exists: feedback is
 * then only kept in `orgs/{orgId}/feedback`. `MATERIA_SUPPORT_EMAIL` on the functions overrides it.
 */
export const SUPPORT_EMAIL = '';
