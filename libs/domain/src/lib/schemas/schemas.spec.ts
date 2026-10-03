import * as D from '../../index';

const ENTITIES = (Object.entries(D) as [string, unknown][]).filter(
  (entry): entry is [string, { schema: unknown; create: unknown; update: unknown; version: number; path: string }] =>
    typeof entry[1] === 'object' &&
    entry[1] !== null &&
    'schema' in entry[1] &&
    'create' in entry[1] &&
    'update' in entry[1],
);

describe('entity schemas', () => {
  it('exports schema, create, update, version and path for every entity in the Domain doc', () => {
    const names = ENTITIES.map(([name]) => name).sort();
    for (const required of [
      'Activity',
      'Asset',
      'AuditEntry',
      'Calendar',
      'ChronologyEntry',
      'Chunk',
      'ClerkMessage',
      'ClerkThread',
      'Contact',
      'CourtBook',
      'CourtEvent',
      'CourtOrder',
      'CreditNote',
      'Deadline',
      'Disbursement',
      'Distribution',
      'DocTemplate',
      'Evidence',
      'Integration',
      'Invite',
      'Invoice',
      'Issue',
      'Liability',
      'Matter',
      'MatterDocument',
      'MatterEvent',
      'MatterTemplate',
      'Member',
      'Metrics',
      'MigrationRun',
      'Note',
      'Notification',
      'Offer',
      'Org',
      'Party',
      'PersonalTask',
      'Proceeding',
      'RuleSetVersion',
      'SafeCustody',
      'Subpoena',
      'Suggestion',
      'Task',
      'TimeEntry',
      'User',
    ]) {
      expect(names).toContain(required);
    }
    for (const [, entity] of ENTITIES) {
      expect(entity.version).toBeGreaterThanOrEqual(1);
      expect(entity.path).toMatch(/^[a-zA-Z{]/);
    }
  });

  it('exports XSchema, XCreateSchema and XUpdateSchema for every entity', () => {
    const exports = D as unknown as Record<string, unknown>;
    expect(ENTITIES.length).toBe(44);
    for (const [name, entity] of ENTITIES) {
      expect(exports[`${name}Schema`], `${name}Schema`).toBe(entity.schema);
      expect(exports[`${name}CreateSchema`], `${name}CreateSchema`).toBe(entity.create);
      expect(exports[`${name}UpdateSchema`], `${name}UpdateSchema`).toBe(entity.update);
    }
  });

  it('keeps server-owned fields out of create inputs and whitelists updates', () => {
    expect(Object.keys(D.Matter.create.shape)).not.toContain('number');
    expect(Object.keys(D.Matter.create.shape)).not.toContain('search');
    expect(Object.keys(D.Invite.update.shape)).toEqual(['role']);
    expect(D.Invite.create.safeParse({ email: 'a@example.com', role: 'lawyer', tokenHash: 'x' }).success).toBe(false);
    expect(D.AuditEntry.update.safeParse({ action: 'x' }).success).toBe(false);
  });

  it('validates suggestion payloads per kind', () => {
    const base = { status: 'proposed', promptId: 'p', promptVersion: 1, model: 'm', dedupeKey: 'k', citations: [] };
    expect(
      D.Suggestion.create.safeParse({ ...base, kind: 'key_fact', payload: { field: 'grantNo', value: '123' } }).success,
    ).toBe(true);
    expect(
      D.Suggestion.create.safeParse({ ...base, kind: 'key_fact', payload: { title: 'wrong shape' } }).success,
    ).toBe(false);
    expect(D.Suggestion.create.safeParse({ ...base, kind: 'unknown', payload: {} }).success).toBe(false);
  });

  it('normalises emails and enforces E.164 phones', () => {
    expect(D.EmailSchema.parse({ type: 'work', address: 'Someone@Example.COM' }).address).toBe('someone@example.com');
    expect(D.PhoneSchema.safeParse({ type: 'mobile', number: '0412345678' }).success).toBe(false);
    expect(D.PhoneSchema.safeParse({ type: 'mobile', number: '+61412345678' }).success).toBe(true);
  });

  it('rejects unknown fields on stored documents (strict)', () => {
    expect(D.Party.schema.safeParse({ contactId: 'c', role: 'executor', extra: 1 }).success).toBe(false);
  });
});
