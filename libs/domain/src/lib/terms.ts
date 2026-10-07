import type { Role } from './schemas/enums';
import { TERMS_STATUS, TERMS_VERSION } from './terms-version.generated';

/**
 * The terms of service and DPA version an org's owner accepts (SEC-01), compiled from the terms'
 * front-matter in docs/compliance. It's a module of its own, apart from the legal documents
 * registry (legal.ts), because the web app checks it before the app loads: importing the registry
 * there would put every document's metadata in the initial bundle.
 */
export { TERMS_STATUS, TERMS_VERSION };

/**
 * Whether owners in this environment (the web app's `environment.name`) are asked to accept the
 * terms. Everywhere once the terms are signed off (`status: final`, SEC-01a); until then only
 * outside prod, so dev and e2e exercise the flow while nobody in prod accepts unreviewed terms.
 */
export function termsAskedIn(environmentName: string, status: 'draft' | 'final' = TERMS_STATUS): boolean {
  return status === 'final' || environmentName !== 'prod';
}

/**
 * Whether this member must accept the terms before using the app: owners only, while the org's
 * accepted version isn't the current one. Other members are never blocked.
 */
export function termsAcceptanceNeeded(
  role: Role | null | undefined,
  acceptedVersion: string | null | undefined,
): boolean {
  return role === 'owner' && acceptedVersion !== TERMS_VERSION;
}
