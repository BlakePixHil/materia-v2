import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import * as D from '@materia/domain';

import { adminStore, parseArgs, type BackfillStore } from './search-tokens.ts';
import { unwrap } from '../seed/interop.ts';

// Namespace import: the workspace lib loads as CommonJS under tsx, so named imports don't resolve.
const domain = unwrap(D);

/**
 * `materia-scripts backfill-matter-roles --project <id> [--dry-run] [--page-size <n>]` (CORE-01a):
 * gives every live contact the `matterRoles` the "Role in matters" filter reads, as
 * `contacts-onPartyWrite` keeps them from then on: the roles of its live party rows on matters that
 * aren't deleted or destroyed, each once, in the Parties tab's order.
 *
 * It reads every party row once (the `parties` collection group, by path), then each matter they
 * name, then pages through the contacts and writes only those whose roles differ, so it is
 * idempotent and a stopped run can simply be run again. Deleted and merged contacts are left alone
 * (they never show in the list). It leaves `updatedAt` alone, and the audit trigger ignores the
 * field. Logs counts only, never names.
 */

type Data = Record<string, unknown>;

export interface MatterRolesReport {
  parties: number;
  matters: number;
  contacts: { read: number; updated: number };
}

const isDeleted = (data: Data) => data['deletedAt'] !== undefined && data['deletedAt'] !== null;
const same = (a: unknown, b: readonly string[]) => JSON.stringify(a ?? []) === JSON.stringify(b);

export async function backfillMatterRoles(
  store: BackfillStore,
  options: { pageSize?: number; dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<MatterRolesReport> {
  const pageSize = options.pageSize ?? 300;
  const report: MatterRolesReport = { parties: 0, matters: 0, contacts: { read: 0, updated: 0 } };

  // Every party row, by its contact (`orgs/{orgId}/contacts/{contactId}`).
  const rows = new Map<string, D.PartyRoleRow[]>();
  const matterPaths = new Set<string>();
  for (let after: string | null = null; ;) {
    const page = await store.page('parties', after, pageSize);
    for (const { path, data } of page) {
      const [root, orgId, matters, matterId, parties] = path.split('/');
      const contactId = data['contactId'];
      if (root !== 'orgs' || matters !== 'matters' || parties !== 'parties' || !orgId || !matterId) continue;
      if (typeof contactId !== 'string' || !contactId) continue;
      const key = `orgs/${orgId}/contacts/${contactId}`;
      rows.set(key, [...(rows.get(key) ?? []), { role: data['role'], matterId, deletedAt: data['deletedAt'] }]);
      if (!isDeleted(data)) matterPaths.add(`orgs/${orgId}/matters/${matterId}`);
    }
    report.parties += page.length;
    after = page.at(-1)?.path ?? null;
    if (page.length < pageSize) break;
  }

  // Which of those matters count: not deleted, not destroyed.
  const live = new Set<string>();
  const paths = [...matterPaths];
  for (let i = 0; i < paths.length; i += pageSize) {
    const chunk = paths.slice(i, i + pageSize);
    const docs = await store.getAll(chunk);
    docs.forEach((doc, j) => {
      if (domain.matterCountsForRoles(doc ?? undefined)) live.add(chunk[j] as string);
    });
  }
  report.matters = paths.length;

  for (let after: string | null = null; ;) {
    const page = await store.page('contacts', after, pageSize);
    const writes = page.flatMap(({ path, data }) => {
      const [root, orgId, contacts] = path.split('/');
      if (root !== 'orgs' || contacts !== 'contacts' || path.split('/').length !== 4) return [];
      if (isDeleted(data) || data['mergedInto']) return [];
      const roles = domain.contactMatterRoles(rows.get(path) ?? [], (matterId) =>
        live.has(`orgs/${orgId}/matters/${matterId}`),
      );
      return same(data['matterRoles'], roles) ? [] : [{ path, patch: { matterRoles: roles } }];
    });
    if (writes.length && !options.dryRun) await store.update(writes);
    report.contacts.read += page.length;
    report.contacts.updated += writes.length;
    after = page.at(-1)?.path ?? null;
    if (page.length < pageSize) break;
  }
  options.log?.(
    `parties: ${report.parties} read; matters: ${report.matters} checked; contacts: ${report.contacts.read} read, ` +
      `${report.contacts.updated} ${options.dryRun ? 'to update' : 'updated'}`,
  );
  return report;
}

export async function main(argv: string[] = []): Promise<void> {
  const { project, dryRun, pageSize } = parseArgs(argv, 'backfill-matter-roles');
  const app = initializeApp({ projectId: project }, `backfill-matter-roles-${Date.now()}`);
  try {
    await backfillMatterRoles(adminStore(getFirestore(app)), { dryRun, pageSize, log: (line) => console.log(line) });
  } finally {
    await deleteApp(app);
  }
}
