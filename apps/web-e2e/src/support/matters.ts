import { type APIRequestContext, type Page } from '@playwright/test';

import { contactSearchTokens, matterSearchTokens } from '@materia/domain';
import { setEmulatorDocument } from '@materia/test-utils/e2e';

/** Fixtures for the Matters e2e (CORE-03): matters and a client stored as the server keeps them. */

export const table = (page: Page) => page.getByRole('table', { name: 'Matters' });

export function uniqueOrg(): string {
  return `org-matters-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const DAY = 86_400_000;

export interface SeedMatter {
  id: string;
  number: string;
  title: string;
  type?: string;
  status?: string;
  responsibleUid: string;
  jurisdiction?: string;
  labels?: string[];
  daysAgo: number;
}

function meta(uid: string) {
  return { createdAt: new Date(), createdBy: uid, updatedAt: new Date(), updatedBy: uid, schemaVersion: 1 };
}

/** A stored matter as the server keeps it. */
export function matterDoc(orgId: string, uid: string, matter: SeedMatter, client = 'Bram Fictional') {
  return {
    path: `orgs/${orgId}/matters/${matter.id}`,
    data: {
      number: matter.number,
      title: matter.title,
      type: matter.type ?? 'probate',
      status: matter.status ?? 'open',
      jurisdiction: matter.jurisdiction ?? 'VIC',
      responsibleUid: matter.responsibleUid,
      teamUids: [matter.responsibleUid],
      clientContactIds: ['c-client'],
      privileged: false,
      priority: 'none',
      labels: matter.labels ?? [],
      relatedMatterIds: [],
      openTaskCount: 0,
      wipCents: 120_000,
      recomputeVersion: 0,
      fee: { arrangement: 'hourly', history: [] },
      costsDisclosure: { status: 'sent' },
      conflictCheck: { status: 'clear' },
      search: matterSearchTokens({ number: matter.number, title: matter.title, clientNames: [client] }),
      lastActivityAt: new Date(Date.now() - matter.daysAgo * DAY),
      deletedAt: null,
      ...meta(uid),
    },
  };
}

export async function seedClient(request: APIRequestContext, orgId: string, uid: string): Promise<void> {
  await setEmulatorDocument(request, `orgs/${orgId}/contacts/c-client`, {
    kind: 'person',
    givenNames: 'Bram',
    familyName: 'Fictional',
    sortName: 'fictional bram',
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    isReferrer: false,
    search: contactSearchTokens({ givenNames: 'Bram', familyName: 'Fictional' }),
    deletedAt: null,
    ...meta(uid),
  });
}
