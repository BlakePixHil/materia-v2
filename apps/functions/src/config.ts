/** Every regional Firebase/GCP resource runs in Sydney (Architecture & ADRs, ADR-003). */
export const REGION = 'australia-southeast1' as const;

/**
 * The From address of every email (FND-20). Replace the placeholder with the sender Postmark has
 * verified (infra/MANUAL.md, "Email: Postmark"); `.example` addresses are never deliverable.
 */
export const MAIL_FROM = 'Materia <notifications@materia.example>';
