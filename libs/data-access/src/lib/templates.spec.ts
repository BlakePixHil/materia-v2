import { TestBed } from '@angular/core/testing';

import { CallableClient } from './callable-client';
import { OrgContext } from './org-context';
import { ORG_TEMPLATES_QUERY, orgTemplatesRepository, TEMPLATE_CALLABLES, templateCallables } from './templates';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

/** Settings → Templates reads and the `templates-*` callables (CORE-07). Fictional data only. */

const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: 'u-priya',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: 'u-priya',
  schemaVersion: 1,
};

function template(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    matterType: 'will',
    stages: [{ id: 'start', name: 'Start', order: 1 }],
    tasks: [],
    deadlineRuleIds: [],
    version: 0,
    source: 'org',
    published: false,
    ...meta,
    ...extra,
  };
}

describe('orgTemplatesRepository', () => {
  it('lists the org’s templates by name with their version and published state', async () => {
    const fs = new InMemoryFirestore();
    fs.set('orgs/org-a/templates/t-2', template('Wills (fictional)', { version: 2, published: true }));
    fs.set(
      'orgs/org-a/templates/t-1',
      template('Advance directives', { basedOn: { templateId: 'system-will', version: 1 } }),
    );
    TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
    TestBed.inject(OrgContext).setSession({ uid: 'u-priya', orgId: 'org-a', role: 'admin' });
    const rows = await TestBed.runInInjectionContext(() => orgTemplatesRepository()).query(ORG_TEMPLATES_QUERY);
    expect(rows.map((row) => [row.id, row.name, row.version, row.published])).toEqual([
      ['t-1', 'Advance directives', 0, false],
      ['t-2', 'Wills (fictional)', 2, true],
    ]);
    expect(rows[0]?.basedOn).toEqual({ templateId: 'system-will', version: 1 });
  });
});

describe('templateCallables', () => {
  it('calls each callable by name with a request id', async () => {
    const calls: { name: string; data: unknown }[] = [];
    const client = new CallableClient(
      {
        call: async <T>(name: string, data: unknown) => {
          calls.push({ name, data });
          return {} as T;
        },
        refreshClaims: async () => undefined,
      },
      { newId: () => '00000000-0000-4000-8000-000000000001' },
    );
    const api = templateCallables(client);
    await api.clone({ sourceTemplateId: 'system-will' });
    await api.save({ templateId: 't-1', name: 'Wills' });
    await api.publish({ templateId: 't-1', stageMapping: { old: 'start' } });
    await api.apply({ matterId: 'm-1', templateId: 't-1', version: 1 });
    expect(calls.map((c) => c.name)).toEqual(Object.values(TEMPLATE_CALLABLES));
    expect(calls[2]?.data).toEqual({
      templateId: 't-1',
      stageMapping: { old: 'start' },
      requestId: '00000000-0000-4000-8000-000000000001',
    });
  });
});
