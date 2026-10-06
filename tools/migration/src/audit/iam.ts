import type { IamTester } from '../legacy/rest.ts';

/**
 * The read-only guard (MIG-01): before reading anything, the audit asks IAM which permissions its
 * credentials hold on the legacy project and bucket, and refuses to run if any of them could
 * change data, rules, IAM or keys, or if the reads it needs are missing. It fails closed: an IAM
 * error stops the run too.
 */

/** Needed to read Firestore and Storage. */
export const REQUIRED_READS = [
  'datastore.entities.get',
  'datastore.entities.list',
  'storage.objects.get',
  'storage.objects.list',
] as const;

/** Read only if granted: the Auth summary MIG-04 uses. */
export const OPTIONAL_READS = ['firebaseauth.users.get'] as const;

/** Anything that writes data, deploys rules, changes IAM or mints credentials. */
export const PROJECT_WRITES = [
  'datastore.entities.create',
  'datastore.entities.update',
  'datastore.entities.delete',
  'datastore.databases.update',
  'datastore.databases.delete',
  'datastore.databases.import',
  'datastore.databases.export',
  'datastore.indexes.create',
  'datastore.indexes.delete',
  'storage.objects.create',
  'storage.objects.update',
  'storage.objects.delete',
  'storage.buckets.update',
  'storage.buckets.delete',
  'storage.buckets.setIamPolicy',
  'firebaseauth.users.create',
  'firebaseauth.users.update',
  'firebaseauth.users.delete',
  'firebaserules.rulesets.create',
  'firebaserules.releases.create',
  'firebaserules.releases.update',
  'resourcemanager.projects.setIamPolicy',
  'iam.serviceAccountKeys.create',
  'iam.serviceAccounts.actAs',
  'iam.serviceAccounts.getAccessToken',
] as const;

/** Bucket-level grants can add writes the project policy doesn't show. */
export const BUCKET_WRITES = [
  'storage.objects.create',
  'storage.objects.update',
  'storage.objects.delete',
  'storage.buckets.update',
  'storage.buckets.setIamPolicy',
] as const;

export interface ReadOnlyCheck {
  /** Every permission IAM granted, project and bucket. */
  granted: string[];
  /** Granted write permissions: any one refuses the run. */
  writes: string[];
  /** Required reads IAM did not grant: any one refuses the run. */
  missingReads: string[];
  /** Whether the Auth summary can be read. */
  authReadable: boolean;
}

export class NotReadOnlyError extends Error {
  constructor(readonly check: ReadOnlyCheck) {
    const reasons = [
      check.writes.length ? `these credentials can write (${check.writes.join(', ')})` : '',
      check.missingReads.length ? `they can't read (${check.missingReads.join(', ')})` : '',
    ].filter(Boolean);
    super(
      `Refusing to read the legacy project: ${reasons.join(' and ')}. Use the read-only migration account ` +
        `(roles/datastore.viewer, roles/storage.objectViewer, roles/firebaseauth.viewer) and nothing else.`,
    );
    this.name = 'NotReadOnlyError';
  }
}

export async function checkReadOnly(iam: IamTester): Promise<ReadOnlyCheck> {
  const projectGranted = await iam.project([...REQUIRED_READS, ...OPTIONAL_READS, ...PROJECT_WRITES]);
  const bucketGranted = await iam.bucket([...BUCKET_WRITES]);
  const granted = [...new Set([...projectGranted, ...bucketGranted.map((p) => `bucket:${p}`)])].sort();
  const writes = [
    ...PROJECT_WRITES.filter((p) => projectGranted.includes(p)),
    ...BUCKET_WRITES.filter((p) => bucketGranted.includes(p)).map((p) => `bucket:${p}`),
  ];
  return {
    granted,
    writes,
    missingReads: REQUIRED_READS.filter((p) => !projectGranted.includes(p)),
    authReadable: projectGranted.includes('firebaseauth.users.get'),
  };
}

/** Throws NotReadOnlyError unless the credentials can read and can't write. */
export async function assertReadOnly(iam: IamTester): Promise<ReadOnlyCheck> {
  const check = await checkReadOnly(iam);
  if (check.writes.length || check.missingReads.length) throw new NotReadOnlyError(check);
  return check;
}

/** The auth import's guard (MIG-04): no writes, and the Auth read it needs (not the data reads). */
export async function assertAuthReadable(iam: IamTester): Promise<ReadOnlyCheck> {
  const check = await checkReadOnly(iam);
  const missingReads = check.authReadable ? [] : [...OPTIONAL_READS];
  if (check.writes.length || missingReads.length) throw new NotReadOnlyError({ ...check, missingReads });
  return check;
}
