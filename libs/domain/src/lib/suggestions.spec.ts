import { Suggestion, SUGGESTION_PAYLOADS, SuggestionProposalSchema, type SuggestionPayload } from './schemas/clerk';
import { SuggestionKindSchema } from './schemas/enums';
import {
  AcceptSuggestionInput,
  basisChanges,
  basisDocumentIds,
  basisPartLabel,
  canAcceptSuggestion,
  defaultDedupeKey,
  hashString,
  isOpenSuggestion,
  keyFactEventKind,
  SUGGESTION_ACCEPT_LABELS,
  SUGGESTION_KIND_ACTION,
  SUGGESTION_KIND_LABELS,
  suggestionAcceptanceRates,
  suggestionBasis,
  suggestionBasisParts,
  suggestionExpired,
  suggestionMetricKeys,
  suggestionSummary,
  sourcesPrivileged,
  stableJson,
} from './suggestions';

/** AI-07: suggestion payloads, summaries, dedupe keys, basis hashing and metrics. Fictional data only. */

const matter = { status: 'open', stageId: 'grant', privileged: false, deletedAt: null, estate: { grantNo: 'G-1' } };
const PAYLOADS: Record<string, unknown> = {
  task: { title: 'Request valuation', dueDate: '2026-10-12' },
  deadline: { title: 'File summons', dueDate: '2026-11-02', kind: 'court' },
  event: { kind: 'date_of_death', date: '2026-07-01' },
  party: { contactId: 'c-1', role: 'beneficiary' },
  key_fact: { field: 'grossValue', value: 125_000_00 },
  note: { bodyMd: 'First line\nSecond line' },
  time_entry: { date: '2026-10-05', minutes: 30, narrative: 'Call with executor' },
  document_meta: { documentId: 'd-1', category: 'will', title: 'Will of Fictional Marlow' },
  chronology: { date: '2026-01-02', datePrecision: 'day', title: 'Will signed', detail: '' },
  order: {
    courtEventId: 'ce-1',
    orderNo: '3',
    text: 'File affidavits',
    requiresAction: true,
    responsiblePartyRole: 'plaintiff',
    status: 'pending',
  },
  evidence: { documentId: 'd-1', supports: 'us', strength: 2 },
};

describe('suggestion payloads', () => {
  it.each(SuggestionKindSchema.options)('%s has a payload schema, a summary and labels', (kind) => {
    const parsed = SUGGESTION_PAYLOADS[kind].safeParse(PAYLOADS[kind]);
    expect(parsed.success).toBe(true);
    expect(suggestionSummary({ kind, payload: parsed.data }).length).toBeGreaterThan(3);
    expect(SUGGESTION_KIND_LABELS[kind]).toBeTruthy();
    expect(SUGGESTION_ACCEPT_LABELS[kind]).toBeTruthy();
    expect(SUGGESTION_KIND_ACTION[kind]).toBeTruthy();
    expect(defaultDedupeKey({ kind, payload: parsed.data } as SuggestionPayload)).toMatch(new RegExp(`^${kind}:`));
  });

  it('checks a key fact value against the fact kind', () => {
    const fact = SUGGESTION_PAYLOADS.key_fact;
    expect(fact.safeParse({ field: 'willDate', value: '2026-01-02' }).success).toBe(true);
    expect(fact.safeParse({ field: 'willDate', value: '2 Jan 2026' }).success).toBe(false);
    expect(fact.safeParse({ field: 'grossValue', value: 12.5 }).success).toBe(false);
    expect(fact.safeParse({ field: 'grantNo', value: '' }).success).toBe(false);
  });

  it('needs a category or a title for document details', () => {
    expect(SUGGESTION_PAYLOADS.document_meta.safeParse({ documentId: 'd-1' }).success).toBe(false);
  });

  it('a proposal defaults its citations; the stored schema needs the server fields', () => {
    const proposal = SuggestionProposalSchema.parse({ kind: 'task', payload: { title: 'Do it' } });
    expect(proposal).toMatchObject({ citations: [], payload: { priority: 'none' } });
    expect(Suggestion.schema.safeParse(proposal).success).toBe(false);
    expect(Suggestion.update.safeParse({ status: 'dismissed' }).success).toBe(false);
  });

  it('summaries read naturally', () => {
    expect(suggestionSummary({ kind: 'task', payload: PAYLOADS['task'] })).toBe('Request valuation · due 2026-10-12');
    expect(suggestionSummary({ kind: 'key_fact', payload: PAYLOADS['key_fact'] })).toBe(
      'Estate gross value: $125,000.00',
    );
    expect(suggestionSummary({ kind: 'event', payload: PAYLOADS['event'] })).toBe('Date of death on 2026-07-01');
    expect(suggestionSummary({ kind: 'note', payload: PAYLOADS['note'] })).toBe('First line');
    expect(suggestionSummary({ kind: 'note', payload: { bodyMd: 'x'.repeat(200) } })).toHaveLength(120);
    expect(suggestionSummary({ kind: 'event', payload: { kind: 'caveat_lodged', date: '2026-01-01' } })).toBe(
      'caveat lodged on 2026-01-01',
    );
  });

  it('accept input takes an edited payload and an expected basis', () => {
    const base = { requestId: '7f8f9d5e-1c2b-4a3d-9e8f-0a1b2c3d4e5f', matterId: 'm-1', suggestionId: 's-1' };
    expect(
      AcceptSuggestionInput.safeParse({ ...base, editedPayload: { title: 'x' }, expectedBasis: 'abc' }).success,
    ).toBe(true);
    expect(AcceptSuggestionInput.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe('permissions and lifecycle', () => {
  it('needs clerk.use and the kind’s action; privileged ones need privileged.view', () => {
    expect(canAcceptSuggestion('readonly', 'task')).toBe(false);
    expect(canAcceptSuggestion('paralegal', 'task')).toBe(true);
    expect(canAcceptSuggestion('paralegal', 'task', true)).toBe(false);
    expect(canAcceptSuggestion('lawyer', 'note', true)).toBe(true);
  });

  it('open statuses and expiry', () => {
    expect(isOpenSuggestion('proposed')).toBe(true);
    expect(isOpenSuggestion('stale')).toBe(true);
    expect(isOpenSuggestion('expired')).toBe(false);
    const at = new Date('2026-10-05T00:00:00Z');
    expect(suggestionExpired({ status: 'proposed', expiresAt: at }, at)).toBe(true);
    expect(suggestionExpired({ status: 'accepted', expiresAt: at }, at)).toBe(false);
    expect(suggestionExpired({ status: 'proposed', expiresAt: at }, new Date('2026-10-04T00:00:00Z'))).toBe(false);
  });

  it('dedupe keys ignore case and spacing', () => {
    const a = defaultDedupeKey({ kind: 'task', payload: { title: 'Request  Valuation ', priority: 'none' } });
    const b = defaultDedupeKey({ kind: 'task', payload: { title: 'request valuation', priority: 'none' } });
    expect(a).toBe(b);
  });
});

describe('basis', () => {
  const sources = (extra: Record<string, unknown> = {}) => ({
    matter: { ...matter, ...extra },
    documents: { 'd-1': { version: 1, privileged: false, name: 'Scan', category: 'other', deletedAt: null } },
  });
  const cited = { citations: [{ documentId: 'd-1' }] };

  it('covers the matter state, the kind’s sources and cited documents', () => {
    const parts = suggestionBasisParts({ kind: 'task', payload: PAYLOADS['task'], ...cited }, sources());
    expect(parts).toEqual({
      'matter.status': 'open',
      'matter.stageId': 'grant',
      'matter.privileged': false,
      'matter.deleted': false,
      'document.d-1.version': 1,
      'document.d-1.privileged': false,
      'document.d-1.deleted': false,
    });
    expect(suggestionBasisParts({ kind: 'key_fact', payload: { field: 'grantNo' } }, sources())['fact.grantNo']).toBe(
      'G-1',
    );
    const event = suggestionBasisParts(
      { kind: 'event', payload: PAYLOADS['event'] },
      {
        ...sources(),
        events: [
          { id: 'e2', date: '2026-07-02' },
          { id: 'e1', date: '2026-07-01' },
        ],
      },
    );
    expect(event['events.date_of_death']).toBe('e1:2026-07-01,e2:2026-07-02');
    expect(event).toHaveProperty('fact.dateOfDeath', null);
    expect(
      suggestionBasisParts({ kind: 'party', payload: PAYLOADS['party'] }, { ...sources(), party: { deletedAt: null } })[
        'party.beneficiary-c-1'
      ],
    ).toBe('live');
    const meta = suggestionBasisParts({ kind: 'document_meta', payload: PAYLOADS['document_meta'] }, sources());
    expect(meta['document.d-1.name']).toBe('Scan');
    expect(basisDocumentIds({ kind: 'document_meta', payload: PAYLOADS['document_meta'], ...cited })).toEqual(['d-1']);
  });

  it('changes when a source changes, and says what changed', () => {
    const before = suggestionBasis(suggestionBasisParts({ kind: 'task', payload: {}, ...cited }, sources()));
    const same = suggestionBasis(
      suggestionBasisParts({ kind: 'task', payload: {}, ...cited }, sources({ title: 'Renamed', openTaskCount: 9 })),
    );
    expect(same.basis).toBe(before.basis);
    const after = suggestionBasis(
      suggestionBasisParts({ kind: 'task', payload: {}, ...cited }, sources({ status: 'on_hold' })),
    );
    expect(after.basis).not.toBe(before.basis);
    expect(basisChanges(before.parts, after.parts)).toEqual(['matter.status']);
    expect(basisChanges({ a: '1' }, { b: '2' })).toEqual(['a', 'b']);
  });

  it('privileged from the matter or a cited document', () => {
    expect(sourcesPrivileged({ kind: 'task', payload: {}, ...cited }, sources())).toBe(false);
    expect(sourcesPrivileged({ kind: 'task', payload: {}, ...cited }, sources({ privileged: true }))).toBe(true);
    const docs = { matter, documents: { 'd-1': { privileged: true } } };
    expect(sourcesPrivileged({ kind: 'task', payload: {}, ...cited }, docs)).toBe(true);
  });

  it.each([
    ['matter.status', 'Matter status'],
    ['matter.stageId', 'Matter stage'],
    ['matter.privileged', 'Whether the matter is privileged'],
    ['matter.deleted', 'Whether the matter was deleted'],
    ['fact.grantNo', 'Grant number'],
    ['events.date_of_death', 'Recorded date of death events'],
    ['party.client-c-1', 'The party on the matter'],
    ['document.d-1.privileged', 'Whether a cited document is privileged'],
    ['document.d-1.version', 'A cited document’s version'],
    ['document.d-1.deleted', 'Whether a cited document was deleted'],
    ['document.d-1.name', 'The document’s title'],
    ['document.d-1.category', 'The document’s category'],
    ['other', 'other'],
  ])('labels %s', (key, label) => expect(basisPartLabel(key)).toBe(label));

  it('hashes stably', () => {
    expect(stableJson({ b: 1, a: [new Date('2026-01-01T00:00:00Z'), undefined, null], c: undefined })).toBe(
      '{"a":["2026-01-01T00:00:00.000Z",null,null],"b":1}',
    );
    expect(stableJson({ toDate: () => new Date('2026-01-01T00:00:00Z') })).toBe('"2026-01-01T00:00:00.000Z"');
    expect(hashString('abc')).toMatch(/^[0-9a-f]{14}$/);
    expect(keyFactEventKind('grantDate')).toBe('grant_issued');
    expect(keyFactEventKind('grantNo')).toBeUndefined();
  });
});

describe('metrics', () => {
  it('keys per total, kind and prompt version', () => {
    expect(
      suggestionMetricKeys({ kind: 'task', promptId: 'suggest', promptVersion: '1.0.0', outcome: 'accepted' }),
    ).toEqual(['suggestions.accepted', 'suggestions.kind.task.accepted', 'suggestions.prompt.suggest@1.0.0.accepted']);
  });

  it('rates are null before anything is resolved', () => {
    expect(suggestionAcceptanceRates({ 'suggestions.proposed': 4, 'other.tokens': 3 })).toEqual({});
    expect(suggestionAcceptanceRates({ 'suggestions.expired': 2 })['all']?.rate).toBe(0);
  });
});
