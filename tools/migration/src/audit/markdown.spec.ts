import { formatBytes, renderAuditMarkdown } from './markdown.ts';
import { auditSnapshot } from './report.ts';
import { FIXTURE_UIDS, loadLegacyFixtures } from '../legacy/fixtures.ts';
import { collectSnapshot, memoryReader } from '../legacy/reader.ts';

describe('renderAuditMarkdown', () => {
  it('renders every section of the report', async () => {
    const { docs, objects } = loadLegacyFixtures();
    const snapshot = await collectSnapshot(memoryReader(docs, objects), FIXTURE_UIDS.subject);
    const report = auditSnapshot(snapshot, {
      generatedAt: '2026-10-06T00:00:00.000Z',
      source: { project: 'legacy-p', bucket: 'legacy-b' },
      readOnly: { granted: ['datastore.entities.get'], writes: [], missingReads: [], authReadable: false },
    });
    const md = renderAuditMarkdown(report);
    for (const heading of [
      '# Legacy data audit (MIG-01)',
      '## Warnings',
      '## Scope',
      '## Counts (in scope)',
      '## Workflows',
      '### Wills & powers',
      '## Referenced users',
      '## Billing and money',
      '## Legacy field names',
      '## Dates',
      '## Rich text',
      '## Attachments',
      '## Orphans and broken links',
      '## Cards',
      '## Referrers',
      '## Profile and sign-in',
      '## Field shapes',
    ]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('**Read-only check:** passed.');
    expect(md).toContain('| Enquiries | `5a1e0000-0000-4000-8000-000000000001` | no | 1 | 0 |');
    expect(md).toContain('| `assignee` | 10 | empty-string × 1, null × 1, uid:other × 1, uid:self × 7 |');
    expect(md).toContain('**Amounts read as dollars.**');
  });

  it('escapes table cells', async () => {
    const report = auditSnapshot(
      {
        uid: 'u',
        profile: null,
        workspaces: [],
        workflows: [
          { path: 'workflows/w', data: { name: 'A | B', users: { u: { roles: { owner: true } } }, swimlanes: [] } },
        ],
        cards: [],
        attachments: [],
        checklistTemplates: [],
        referrers: [],
        dashboardItems: [],
        integrations: [],
        storageObjects: [],
        people: {},
        linkedCardsElsewhere: {},
      },
      { generatedAt: 'now', source: { project: 'p', bucket: 'b' } },
    );
    const md = renderAuditMarkdown(report);
    expect(md).toContain('| A \\| B | owner | in |');
    expect(md).toContain('no profile found');
  });

  it('formats sizes', () => {
    expect([formatBytes(10), formatBytes(2048), formatBytes(27_262_976)]).toEqual(['10 B', '2.0 KB', '26.0 MB']);
  });
});
