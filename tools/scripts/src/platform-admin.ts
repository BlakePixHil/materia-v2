import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

/**
 * `materia-scripts platform-admin --project <id> --uid <uid> [--revoke]` (FND-23): grants or revokes
 * the `platformAdmin` claim that `flags-setOrgOverride` requires. Only a human runs this, with
 * Application Default Credentials for the project (or against the emulator with
 * FIREBASE_AUTH_EMULATOR_HOST set). Existing claims (org, role) are kept.
 */
export function parseArgs(argv: string[]): { project: string; uid: string; revoke: boolean } {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const project = value('project');
  const uid = value('uid');
  if (!project || !uid) throw new Error('Usage: materia-scripts platform-admin --project <id> --uid <uid> [--revoke]');
  return { project, uid, revoke: argv.includes('--revoke') };
}

export async function main(argv: string[] = []): Promise<void> {
  const { project, uid, revoke } = parseArgs(argv);
  const app = initializeApp({ projectId: project }, `platform-admin-${Date.now()}`);
  try {
    const auth = getAuth(app);
    const user = await auth.getUser(uid);
    const claims = { ...(user.customClaims ?? {}) } as Record<string, unknown>;
    if (revoke) delete claims['platformAdmin'];
    else claims['platformAdmin'] = true;
    await auth.setCustomUserClaims(uid, claims);
    console.log(
      `${revoke ? 'Revoked' : 'Granted'} platformAdmin for ${uid} in ${project}. They must sign in again (or refresh their token).`,
    );
  } finally {
    await deleteApp(app);
  }
}
