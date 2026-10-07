import { randomUUID } from 'node:crypto';

/**
 * A short-lived App Check debug token for a dev harness (MOB-02b). A browser driven by Playwright
 * scores too low with reCAPTCHA Enterprise to get an App Check token, so a harness that measures a
 * returning phone (which has one) registers a debug token for its run, lets its browser exchange
 * it once, and removes it before measuring. Dev only (the threat model allows debug tokens in dev
 * alone); the token is generated here and never printed.
 */

const FIREBASE = 'https://firebase.googleapis.com/v1beta1';
const APP_CHECK = 'https://firebaseappcheck.googleapis.com/v1';
/** The display name of every token a harness registers, so a failed run's token is found later. */
export const DEBUG_TOKEN_PREFIX = 'demo-lighthouse';
/** A harness token older than this is left over from a failed run. */
const STALE_MS = 60 * 60_000;

export interface AppCheckDebugDeps {
  fetch: typeof fetch;
  token: () => Promise<string>;
  now: () => number;
}

export interface DebugToken {
  /** The secret the browser sets as `FIREBASE_APPCHECK_DEBUG_TOKEN`. */
  token: string;
  /** The registered token's resource name, to remove it. */
  name: string;
}

async function call(deps: AppCheckDebugDeps, project: string, url: string, init: RequestInit = {}) {
  return deps.fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${await deps.token()}`,
      'content-type': 'application/json',
      'x-goog-user-project': project,
    },
  });
}

async function ok(response: Response, what: string): Promise<Response> {
  if (response.ok) return response;
  const body = await response.text().catch(() => '');
  throw new Error(`${what} failed (${response.status}): ${body.slice(0, 300)}`);
}

/** The project's web app (Terraform creates one), whose App Check settings the site uses. */
export async function webAppId(project: string, deps: AppCheckDebugDeps): Promise<string> {
  const response = await ok(
    await call(deps, project, `${FIREBASE}/projects/${project}/webApps`),
    'Listing the Firebase web apps',
  );
  const { apps = [] } = (await response.json()) as { apps?: { appId?: string; state?: string }[] };
  const active = apps.filter((app) => app.appId && app.state !== 'DELETED');
  if (active.length !== 1) throw new Error(`Expected one Firebase web app on ${project}, found ${active.length}.`);
  return active[0]?.appId as string;
}

/** `projects/{number}/apps/{appId}`: App Check names apps by project number, which the app id holds. */
function appName(appId: string): string {
  const number = appId.split(':')[1];
  if (!number || !/^\d+$/.test(number)) throw new Error(`Unexpected Firebase app id ${appId}.`);
  return `projects/${number}/apps/${appId}`;
}

/** Registers a debug token for this run, first removing any a failed run left behind. */
export async function addDebugToken(project: string, appId: string, deps: AppCheckDebugDeps): Promise<DebugToken> {
  const parent = `${APP_CHECK}/${appName(appId)}/debugTokens`;
  const listed = await ok(await call(deps, project, parent), 'Listing App Check debug tokens');
  const { debugTokens = [] } = (await listed.json()) as {
    debugTokens?: { name: string; displayName?: string; updateTime?: string }[];
  };
  for (const old of debugTokens) {
    const updated = Date.parse(old.updateTime ?? '');
    if (old.displayName?.startsWith(DEBUG_TOKEN_PREFIX) && !(deps.now() - updated < STALE_MS))
      await removeDebugToken(project, old.name, deps);
  }
  const token = randomUUID();
  const created = await ok(
    await call(deps, project, parent, {
      method: 'POST',
      body: JSON.stringify({ displayName: `${DEBUG_TOKEN_PREFIX} ${new Date(deps.now()).toISOString()}`, token }),
    }),
    'Registering an App Check debug token',
  );
  const { name } = (await created.json()) as { name: string };
  return { token, name };
}

export async function removeDebugToken(project: string, name: string, deps: AppCheckDebugDeps): Promise<void> {
  const response = await call(deps, project, `${APP_CHECK}/${name}`, { method: 'DELETE' });
  if (response.status !== 404) await ok(response, 'Removing an App Check debug token');
}
