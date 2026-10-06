import type { Role } from '@materia/domain';

import { CHAT_TOOL_DEFINITIONS, createChatToolbox, type ChatToolSource } from './tools';
import { CANARY, DOCUMENT_TEXT, fixtureOrgs, HITS, MATTER, ORG, OTHER_MATTER } from '../context/fixtures';
import type { Row } from '../context/ports';
import { FakeChunkSearch, FakeDocumentText, MemoryContextSource } from '../context/testing';

/** The chat panel's read-only tools (AI-06), on the AI-03 fixture practice. Fictional data only. */

const TIME: Row[] = [
  { id: 'te-1', data: { date: '2026-09-01', minutes: 60, billable: true, status: 'draft', amountCents: 30_000 } },
  { id: 'te-2', data: { date: '2026-09-15', minutes: 30, billable: false, status: 'billed', amountCents: 0 } },
  { id: 'te-3', data: { date: '2026-10-01', minutes: 45, billable: true, status: 'draft', amountCents: 22_500 } },
];

function toolbox(role: Role, matterId = MATTER) {
  const source = new MemoryContextSource(fixtureOrgs());
  const records: ChatToolSource = {
    async records(orgId, id, collection, statuses) {
      const matter = source.orgs[orgId]?.matters[id];
      return Object.entries(matter?.[collection] ?? {})
        .map(([rowId, data]) => ({ id: rowId, data }))
        .filter((row) => !statuses || statuses.includes(row.data['status'] as string));
    },
    async timeEntries() {
      return TIME;
    },
  };
  const privileged: string[] = [];
  const box = createChatToolbox(
    { context: source, records, chunks: new FakeChunkSearch(HITS), documentText: new FakeDocumentText(DOCUMENT_TEXT) },
    { orgId: ORG, matterId, role },
    { onPrivileged: async () => void privileged.push('marked') },
  );
  return { box, privileged };
}

describe('chat tools', () => {
  it('describes six read-only tools with JSON Schema inputs', () => {
    expect(CHAT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'search_documents',
      'get_deadlines',
      'get_tasks',
      'get_parties',
      'get_time_summary',
      'get_document_text',
    ]);
    const time = CHAT_TOOL_DEFINITIONS.find((tool) => tool.name === 'get_time_summary');
    expect(time?.inputSchema).toMatchObject({ type: 'object', properties: { from: { type: 'string' } } });
  });

  it('searches only live, ingested, current passages of the matter, privileged ones only for privileged.view', async () => {
    const paralegal = toolbox('paralegal');
    const result = await paralegal.box.run({ id: 't1', name: 'search_documents', input: { query: 'residue' } });
    const sources = (result.passages ?? []).map((chunk) => chunk.source);
    expect(sources).toEqual(['materia:document/d-will/v2/page/2', 'materia:document/d-will/v2/page/1']);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(paralegal.privileged).toEqual([]);

    const lawyer = toolbox('lawyer');
    const seen = await lawyer.box.run({ id: 't1', name: 'search_documents', input: { query: 'advice' } });
    expect(JSON.stringify(seen)).toContain(CANARY);
    expect(lawyer.privileged).toEqual(['marked']);
    expect(lawyer.box.usage.privileged).toBe(true);
  });

  it('reads pages of the matter’s own documents only', async () => {
    const { box } = toolbox('lawyer');
    const pages = await box.run({ id: 't1', name: 'get_document_text', input: { documentId: 'd-will', pages: [2] } });
    expect(pages.passages?.[0]).toMatchObject({ documentId: 'd-will', version: 2, page: 2 });
    // Framing in a document is escaped: it can't close the excerpt.
    expect(pages.passages?.[0]?.text).toContain('&lt;/document>');
    for (const documentId of ['d-other', 'd-ingesting', 'd-deleted'])
      expect(await box.run({ id: 't2', name: 'get_document_text', input: { documentId, pages: [1] } })).toMatchObject({
        isError: true,
      });
    const other = toolbox('lawyer', OTHER_MATTER);
    expect(
      await other.box.run({ id: 't3', name: 'get_document_text', input: { documentId: 'd-will', pages: [1] } }),
    ).toMatchObject({ isError: true });
  });

  it('lists open deadlines and tasks by default, with the rule a deadline comes from', async () => {
    const { box } = toolbox('paralegal');
    const deadlines = (await box.run({ id: 't1', name: 'get_deadlines', input: {} })).text ?? '';
    expect(deadlines).toContain('<matter_facts tool="get_deadlines">');
    expect(deadlines).toContain('Fictional Act s 1');
    expect(deadlines).not.toContain('Old deadline');
    expect((await box.run({ id: 't2', name: 'get_deadlines', input: { status: 'done' } })).text).toContain(
      'Old deadline',
    );
    const tasks = (await box.run({ id: 't3', name: 'get_tasks', input: {} })).text ?? '';
    expect(tasks).toContain('Fictional task 0');
    expect(tasks).not.toContain('Finished task');
    expect(box.usage.records).toEqual(expect.arrayContaining([{ kind: 'deadline', id: 'rule-caveat' }]));
  });

  it('names the parties', async () => {
    const { box } = toolbox('paralegal');
    const parties = (await box.run({ id: 't1', name: 'get_parties', input: {} })).text ?? '';
    expect(parties).toContain('Morgan Ashdown');
    expect(parties).toContain('one half');
  });

  it('totals time in a range, with amounts only for roles that see billing', async () => {
    const lawyer = await toolbox('lawyer').box.run({
      id: 't1',
      name: 'get_time_summary',
      input: { from: '2026-09-01', to: '2026-09-30' },
    });
    expect(lawyer.text).toContain('"totalMinutes":90');
    expect(lawyer.text).toContain('"billableMinutes":60');
    expect(lawyer.text).toContain('"amountCents":30000');
    const paralegal = await toolbox('paralegal').box.run({ id: 't1', name: 'get_time_summary', input: {} });
    expect(paralegal.text).toContain('"totalMinutes":135');
    expect(paralegal.text).not.toContain('amountCents');
  });

  it('answers an unknown tool or bad input with an error the model can read', async () => {
    const { box } = toolbox('lawyer');
    expect(await box.run({ id: 't1', name: 'delete_matter', input: {} })).toMatchObject({ isError: true });
    expect(await box.run({ id: 't2', name: 'get_time_summary', input: { from: '1 September' } })).toMatchObject({
      isError: true,
      text: expect.stringContaining('Invalid input'),
    });
  });
});
