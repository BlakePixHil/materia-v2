import type { z } from 'zod';

import * as D from '@materia/domain';

/**
 * Test factories: `makeX(overrides)` for every domain entity, valid by construction (parsed through
 * the entity's schema). All data is fictional; the names are the cast of the design mockups.
 */

export const TEST_ORG_ID = 'org-test-1';
export const TEST_UID = 'user-test-1';
export const TEST_MATTER_ID = 'matter-test-1';
export const FIXED_INSTANT = new Date('2026-10-01T00:00:00.000Z');

const ZERO = 0 as D.Cents;

function meta(version = 1) {
  return {
    createdAt: FIXED_INSTANT,
    createdBy: TEST_UID,
    updatedAt: FIXED_INSTANT,
    updatedBy: TEST_UID,
    schemaVersion: version,
  };
}

type Entity<T> = { schema: z.ZodType<T>; version: number };

function build<T>(entity: Entity<T>, base: Record<string, unknown>, overrides: Partial<T> = {}): T {
  return entity.schema.parse({ ...meta(entity.version), ...base, ...overrides });
}

const d = D.dateOnly;
const sha = 'a'.repeat(64);

export const makeOrg = (o: Partial<D.Org> = {}) =>
  build(
    D.Org,
    {
      name: 'Example Legal (Fictional)',
      abn: '00000000000',
      practiceType: 'wills_estates',
      jurisdictions: ['VIC'],
      primaryJurisdiction: 'VIC',
      timezone: D.DEFAULT_ORG_TIMEZONE,
      holidayLocality: 'VIC_GREATER_GEELONG',
      billing: {
        unitMinutes: 6,
        rounding: 'up',
        gstRegistered: true,
        defaultRateCents: 45000,
        invoicePrefix: 'INV',
        paymentTermsDays: 14,
      },
      matterNumberFormat: 'M-{YYYY}-{seq:4}',
      fy: { startMonth: 7 },
      retentionYears: 7,
      plan: 'standard',
      security: { mfaRequired: false, sessionIdleMinutes: 30 },
    },
    o,
  );

export const makeMember = (o: Partial<D.Member> = {}) =>
  build(
    D.Member,
    {
      role: 'lawyer',
      status: 'active',
      displayName: 'Catherine Whitfield',
      initials: 'CW',
      title: 'Senior Associate',
      defaultRateCents: 45000,
      colour: '#346CFC',
    },
    o,
  );

export const makeInvite = (o: Partial<D.Invite> = {}) =>
  build(
    D.Invite,
    {
      email: 'new.member@example.com',
      role: 'paralegal',
      tokenHash: 'f'.repeat(64),
      expiresAt: new Date('2026-10-08T00:00:00Z'),
      status: 'pending',
      invitedBy: TEST_UID,
    },
    o,
  );

export const makeUser = (o: Partial<D.User> = {}) =>
  build(
    D.User,
    {
      email: 'catherine@example.com',
      displayName: 'Catherine Whitfield',
      firstName: 'Catherine',
      lastName: 'Whitfield',
      orgIds: [TEST_ORG_ID],
      activeOrgId: TEST_ORG_ID,
      prefs: {
        theme: 'system',
        density: 'comfortable',
        shortcuts: true,
        notifications: { email: true, push: false, digestHour: 7 },
      },
    },
    o,
  );

/** A browser's push token (FND-20, MOB-04). The token is a made-up string, not a real FCM token. */
export const makeDevice = (o: Partial<D.Device> = {}) =>
  build(
    D.Device,
    { token: 'fake-fcm-token-0001', platform: 'web', label: 'Chrome on macOS', lastSeenAt: FIXED_INSTANT },
    o,
  );

export const makeTimer = (o: Partial<D.Timer> = {}) =>
  build(
    D.Timer,
    {
      orgId: TEST_ORG_ID,
      matterId: TEST_MATTER_ID,
      matterNumber: 'M-2026-0001',
      startedAt: FIXED_INSTANT,
      accumulatedMs: 0,
      running: true,
      narrativeDraft: '',
      lastHeartbeatAt: FIXED_INSTANT,
    },
    o,
  );

export const makeContact = (o: Partial<D.Contact> = {}) =>
  build(
    D.Contact,
    {
      kind: 'person',
      givenNames: 'Margaret',
      familyName: 'Whitfield',
      dateOfDeath: d('2026-07-14'),
      emails: [],
      phones: [{ type: 'mobile', number: '+61400000000' }],
      addresses: [
        {
          type: 'residential',
          line1: '1 Example Street',
          suburb: 'Geelong',
          state: 'VIC',
          postcode: '3220',
          country: 'AU',
        },
      ],
      search: ['mar', 'marg', 'margaret', 'whi', 'whit', 'whitfield'],
      dedupeKey: 'person:margaret whitfield|',
      sortName: 'margaret whitfield',
    },
    o,
  );

export const makeMatter = (o: Partial<D.Matter> = {}) =>
  build(
    D.Matter,
    {
      number: 'M-2026-0001',
      title: 'Estate of Margaret Whitfield',
      type: 'probate',
      status: 'open',
      jurisdiction: 'VIC',
      responsibleUid: TEST_UID,
      clientContactIds: ['contact-test-1'],
      deceased: {
        contactId: 'contact-test-2',
        dateOfDeath: d('2026-07-14'),
        domicile: 'VIC',
        lastAddress: '1 Example Street, Geelong VIC 3220',
      },
      fee: { arrangement: 'hourly' },
      costsDisclosure: { status: 'required' },
      conflictCheck: { status: 'clear' },
      search: ['est', 'estate', 'whi', 'whitfield', 'm-2026-0001'],
    },
    o,
  );

export const makeParty = (o: Partial<D.Party> = {}) =>
  build(D.Party, { orgId: TEST_ORG_ID, matterId: TEST_MATTER_ID, contactId: 'contact-test-3', role: 'executor' }, o);

export const makeTask = (o: Partial<D.Task> = {}) =>
  build(
    D.Task,
    {
      orgId: TEST_ORG_ID,
      matterId: TEST_MATTER_ID,
      title: 'Obtain death certificate',
      status: 'todo',
      priority: 'high',
      dueDate: d('2026-10-20'),
      order: 1,
    },
    o,
  );

export const makePersonalTask = (o: Partial<D.PersonalTask> = {}) =>
  build(
    D.PersonalTask,
    { orgId: TEST_ORG_ID, title: 'Review trust account reconciliation', status: 'todo', order: 1 },
    o,
  );

export const makeMatterEvent = (o: Partial<D.MatterEvent> = {}) =>
  build(D.MatterEvent, { kind: 'date_of_death', date: d('2026-07-14'), privileged: false }, o);

export const makeDeadline = (o: Partial<D.Deadline> = {}) =>
  build(
    D.Deadline,
    {
      orgId: TEST_ORG_ID,
      matterId: TEST_MATTER_ID,
      title: 'Illustrative deadline (not legal advice)',
      dueDate: d('2027-01-14'),
      kind: 'statutory',
      critical: true,
      status: 'upcoming',
      assigneeUid: TEST_UID,
      computed: {
        ruleId: 'example-rule',
        ruleSetId: 'vic-illustrative',
        ruleSetVersion: 1,
        anchorEventId: 'event-test-1',
        inputs: { months: 6 },
        trace: ['anchor 2026-07-14', '+6 months'],
      },
      privileged: false,
    },
    o,
  );

/** A pending proposal to move a computed deadline (CORE-10). */
export const makeDeadlineChange = (o: Partial<D.DeadlineChange> = {}) =>
  build(
    D.DeadlineChange,
    {
      orgId: TEST_ORG_ID,
      matterId: TEST_MATTER_ID,
      deadlineId: 'rule-example-rule',
      ruleId: 'example-rule',
      title: 'Illustrative deadline (not legal advice)',
      critical: true,
      kind: 'moved',
      cause: 'event',
      status: 'pending',
      fromDueDate: d('2027-01-14'),
      toDueDate: d('2027-01-21'),
      earlier: false,
      intoPast: false,
      assigneeUid: TEST_UID,
      recomputeVersion: 2,
      privileged: false,
    },
    o,
  );

export const makeMatterDocument = (o: Partial<D.MatterDocument> = {}) =>
  build(
    D.MatterDocument,
    {
      orgId: TEST_ORG_ID,
      matterId: TEST_MATTER_ID,
      name: 'Will of Margaret Whitfield (fictional).pdf',
      storagePath: `orgs/${TEST_ORG_ID}/matters/${TEST_MATTER_ID}/documents/doc-test-1/v1`,
      mime: 'application/pdf',
      sizeBytes: 123456,
      sha256: sha,
      version: 1,
      versionSeq: 1,
      versions: [
        {
          version: 1,
          storagePath: `orgs/${TEST_ORG_ID}/matters/${TEST_MATTER_ID}/documents/doc-test-1/v1`,
          fileName: 'Will of Margaret Whitfield (fictional).pdf',
          mime: 'application/pdf',
          sizeBytes: 123456,
          sha256: sha,
          uploadedAt: FIXED_INSTANT,
          uploadedBy: TEST_UID,
          pageCount: 4,
        },
      ],
      category: 'will',
      scan: { status: 'clean' },
      ingest: { status: 'done', pages: 4 },
      source: 'upload',
      pageCount: 4,
      deletedAt: null,
    },
    o,
  );

/** A content-hash index entry (CORE-12): the hash is the document id. */
export const makeDocumentHash = (o: Partial<D.DocumentHash> = {}) =>
  build(D.DocumentHash, { documentId: 'doc-test-1' }, o);

export const makeChunk = (o: Partial<D.Chunk> = {}) =>
  build(
    D.Chunk,
    {
      orgId: TEST_ORG_ID,
      matterId: TEST_MATTER_ID,
      text: 'I appoint my daughter Catherine Whitfield as executor.',
      page: 1,
      docVersion: 1,
      ordinal: 0,
      privileged: false,
      embedding: Array.from({ length: 768 }, (_, i) => (i % 7) / 7),
    },
    o,
  );

export const makeNote = (o: Partial<D.Note> = {}) =>
  build(D.Note, { bodyMd: 'Called @[user-test-1] about the grant.', mentions: { uids: [TEST_UID], matterIds: [] } }, o);

export const makeActivity = (o: Partial<D.Activity> = {}) =>
  build(D.Activity, { kind: 'task.completed', summary: 'Completed a task', actorUid: TEST_UID, at: FIXED_INSTANT }, o);

export const makeTimeEntry = (o: Partial<D.TimeEntry> = {}) =>
  build(
    D.TimeEntry,
    {
      orgId: TEST_ORG_ID,
      matterId: TEST_MATTER_ID,
      uid: TEST_UID,
      date: d('2026-10-01'),
      minutes: 18,
      units: 3,
      rateCents: 45000,
      amountCents: 13500,
      narrative: 'Review will and file note',
      billable: true,
      status: 'draft',
    },
    o,
  );

export const makeDisbursement = (o: Partial<D.Disbursement> = {}) =>
  build(
    D.Disbursement,
    {
      date: d('2026-10-01'),
      orgId: TEST_ORG_ID,
      matterId: TEST_MATTER_ID,
      description: 'Probate filing fee (fictional amount)',
      amountExGstCents: 10000,
      gstCents: ZERO,
      gstTreatment: 'gst_free',
      payee: 'Court registry',
      status: 'unbilled',
      wipCountedCents: ZERO,
    },
    o,
  );

export const makeAsset = (o: Partial<D.Asset> = {}) =>
  build(
    D.Asset,
    {
      class: 'bank',
      description: 'Savings account (fictional)',
      valueAtDeathCents: 2500000,
      valuationSource: 'Bank statement',
      jointlyHeld: false,
      passesOutsideEstate: false,
      status: 'identified',
    },
    o,
  );

export const makeLiability = (o: Partial<D.Liability> = {}) =>
  build(D.Liability, { class: 'funeral', creditor: 'Example Funerals', amountCents: 850000, status: 'notified' }, o);

export const makeDistribution = (o: Partial<D.Distribution> = {}) =>
  build(D.Distribution, { beneficiaryPartyId: 'party-test-1', kind: 'residuary', status: 'planned' }, o);

export const makeSuggestion = (o: Partial<D.Suggestion> = {}) =>
  build(
    D.Suggestion,
    {
      orgId: TEST_ORG_ID,
      matterId: TEST_MATTER_ID,
      kind: 'task',
      payload: { title: 'Publish notice of intention to apply', priority: 'medium' },
      citations: [{ documentId: 'doc-test-1', page: 2, quote: 'I appoint my daughter' }],
      status: 'proposed',
      promptId: 'suggest-tasks',
      promptVersion: '1.0.0',
      model: 'claude-opus-5-5',
      privileged: false,
      basis: '00000000000000',
      basisParts: {},
      dedupeKey: 'task:publish notice of intention to apply|',
      expiresAt: new Date('2026-10-19T00:00:00.000Z'),
    },
    o,
  );

/** Where Clerk found a key fact's value, kept when its suggestion was accepted (CORE-06a). */
export const makeFactCitation = (o: Partial<D.FactCitation> = {}) =>
  build(
    D.FactCitation,
    {
      factId: 'willDate',
      value: d('2019-05-03'),
      citations: [
        { kind: 'document', documentId: 'doc-test-1', docVersion: 1, page: 2, quote: 'Signed on 3 May 2019' },
      ],
      suggestionId: 'suggestion-test-1',
      privileged: false,
    },
    o,
  );

/** A matter's brief on Overview (AI-06c), as the template writes it. */
export const makeMatterBrief = (o: Partial<D.MatterBrief> = {}) =>
  build(
    D.MatterBrief,
    {
      source: 'template',
      reason: 'off',
      headline: 'Nothing overdue; 1 item due in the next 14 days.',
      items: [
        {
          kind: 'due',
          text: 'Deadline “Apply for probate” is due Fri 16 Oct.',
          refs: [{ kind: 'deadline', id: 'deadline-test-1', label: 'Apply for probate' }],
        },
      ],
      read: { deadlines: 1, tasks: 0, changes: 0, documents: 0, suggestions: 0 },
      day: d('2026-10-01'),
      factsHash: '0123456789abcd',
      privileged: false,
      generatedAt: FIXED_INSTANT,
      generatedBy: TEST_UID,
    },
    o,
  );

export const makeClerkThread = (o: Partial<D.ClerkThread> = {}) =>
  build(D.ClerkThread, { title: 'Grant timeline', ownerUid: TEST_UID, matterId: TEST_MATTER_ID }, o);

export const makeClerkDraft = (o: Partial<D.ClerkDraft> = {}) =>
  build(
    D.ClerkDraft,
    {
      typeId: 'bank-balance-request',
      title: 'Bank balance request: Surfcoast Community Bank',
      ownerUid: TEST_UID,
      recipients: [{ name: 'Surfcoast Community Bank', address: 'PO Box 1\nTorquay VIC 3228' }],
      status: 'ready',
      bodyMd: 'Dear Sir or Madam\n\nPlease tell us the balance as at [[TO CONFIRM: date of death]].',
      provenance: [{ origin: 'clerk', length: 82 }],
      deletedAt: null,
    },
    o,
  );

export const makeClerkMessage = (o: Partial<D.ClerkMessage> = {}) =>
  build(
    D.ClerkMessage,
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'The will names Catherine Whitfield as executor.' }],
      status: 'done',
      usage: { inputTokens: 1200, outputTokens: 80 },
    },
    o,
  );

export const makeProceeding = (o: Partial<D.Proceeding> = {}) =>
  build(
    D.Proceeding,
    {
      court: 'VSC',
      list: 'Illustrative list',
      location: 'Melbourne',
      fileNumber: 'S ECI 2026 00000',
      stage: 'pleadings',
      filedOn: d('2026-09-01'),
      ourRole: 'executor',
    },
    o,
  );

export const makeCourtEvent = (o: Partial<D.CourtEvent> = {}) =>
  build(
    D.CourtEvent,
    {
      proceedingId: 'proceeding-test-1',
      kind: 'directions',
      date: d('2026-11-10'),
      time: '10:00',
      location: 'Melbourne',
    },
    o,
  );

export const makeCourtOrder = (o: Partial<D.CourtOrder> = {}) =>
  build(
    D.CourtOrder,
    {
      courtEventId: 'court-event-test-1',
      orderNo: '1',
      text: 'File and serve an affidavit within 28 days (fictional).',
      requiresAction: true,
      responsiblePartyRole: 'executor',
      status: 'pending',
    },
    o,
  );

export const makeChronologyEntry = (o: Partial<D.ChronologyEntry> = {}) =>
  build(
    D.ChronologyEntry,
    { date: d('2019-03-01'), datePrecision: 'day', title: 'Will executed', detail: 'Fictional chronology entry' },
    o,
  );

export const makeIssue = (o: Partial<D.Issue> = {}) =>
  build(D.Issue, { title: 'Adequacy of provision', ourPosition: 'Provision was adequate (fictional).' }, o);

export const makeEvidence = (o: Partial<D.Evidence> = {}) =>
  build(D.Evidence, { documentId: 'doc-test-1', supports: 'us', strength: 2 }, o);

export const makeSubpoena = (o: Partial<D.Subpoena> = {}) =>
  build(
    D.Subpoena,
    {
      issuedTo: 'Example Bank (fictional)',
      direction: 'issued',
      issuedOn: d('2026-09-15'),
      returnDate: d('2026-10-15'),
      status: 'served',
    },
    o,
  );

export const makeOffer = (o: Partial<D.Offer> = {}) =>
  build(
    D.Offer,
    {
      kind: 'calderbank',
      by: 'us',
      madeOn: d('2026-09-20'),
      termsMd: 'Fictional terms',
      status: 'open',
      privileged: true,
    },
    o,
  );

export const makeCourtBook = (o: Partial<D.CourtBook> = {}) =>
  build(
    D.CourtBook,
    {
      title: 'Court book (fictional)',
      tabs: [{ title: 'Pleadings', entries: [{ documentId: 'doc-test-1', version: 1 }] }],
      status: 'draft',
    },
    o,
  );

const line = {
  kind: 'time',
  description: 'Professional fees',
  quantity: 1,
  amountExGstCents: 13500,
  gstCents: 1350,
} as const;

export const makeInvoice = (o: Partial<D.Invoice> = {}) =>
  build(
    D.Invoice,
    {
      number: 'INV-000001',
      matterId: TEST_MATTER_ID,
      issueDate: d('2026-10-01'),
      dueDate: d('2026-10-15'),
      lines: [line],
      subtotalCents: 13500,
      gstCents: 1350,
      totalCents: 14850,
      paymentTermsDays: 14,
      status: 'issued',
    },
    o,
  );

export const makeNoteRevision = (o: Partial<D.NoteRevision> = {}) =>
  build(
    D.NoteRevision,
    {
      bodyMd: 'Called the executor.',
      privileged: false,
      editedAt: new Date('2026-01-02T03:04:05.000Z'),
      editedBy: TEST_UID,
    },
    o,
  );
export const makeCreditNote = (o: Partial<D.CreditNote> = {}) =>
  build(
    D.CreditNote,
    {
      number: 'CN-000001',
      invoiceId: 'invoice-test-1',
      invoiceNumber: 'INV-000001',
      matterId: TEST_MATTER_ID,
      issueDate: d('2026-10-05'),
      reason: 'Fee reduction',
      full: false,
      lines: [{ ...line, amountExGstCents: 1000, gstCents: 100, invoiceLine: 0 }],
      subtotalCents: 1000,
      gstCents: 100,
      totalCents: 1100,
    },
    o,
  );

export const makeInvoiceReminder = (o: Partial<D.InvoiceReminder> = {}) =>
  build(
    D.InvoiceReminder,
    {
      invoiceId: 'invoice-test-1',
      invoiceNumber: 'INV-000001',
      matterId: TEST_MATTER_ID,
      threshold: 7,
      dueDate: d('2026-10-15'),
      balanceCents: 14850,
      lawyerUid: TEST_UID,
      to: ['client@example.com'],
      status: 'pending',
    },
    o,
  );

const templateContent = {
  name: 'Probate (fictional)',
  matterType: 'probate' as const,
  stages: [
    { id: 'instructions', name: 'Instructions', order: 1 },
    { id: 'grant_issued', name: 'Grant issued', order: 2, entryRequires: { facts: ['grantDate' as const] } },
  ],
  tasks: [
    {
      key: 'obtain_death_certificate',
      title: 'Obtain death certificate',
      stageId: 'instructions',
      assignTo: 'role:paralegal' as const,
      due: { fromStageEntry: 14 },
      priority: 'medium' as const,
    },
  ],
  deadlineRuleIds: [],
};

export const makeMatterTemplate = (o: Partial<D.MatterTemplate> = {}) =>
  build(D.MatterTemplate, { ...templateContent, version: 0, published: false, source: 'org' }, o);

export const makeMatterTemplateVersion = (o: Partial<D.MatterTemplateVersion> = {}) =>
  build(
    D.MatterTemplateVersion,
    {
      ...templateContent,
      templateId: 'template-1',
      version: 1,
      source: 'org',
      published: true,
      publishedAt: new Date('2026-10-04T00:00:00Z'),
      publishedBy: 'user-1',
    },
    o,
  );

export const makeDocTemplate = (o: Partial<D.DocTemplate> = {}) =>
  build(
    D.DocTemplate,
    {
      name: 'Engagement letter',
      kind: 'letter',
      storagePath: `orgs/${TEST_ORG_ID}/docTemplates/doctemplate-1/v1.docx`,
      fields: ['client.fullName', 'matter.number'],
      version: 1,
      versions: [
        {
          version: 1,
          storagePath: `orgs/${TEST_ORG_ID}/docTemplates/doctemplate-1/v1.docx`,
          fileName: 'engagement.docx',
          sizeBytes: 1024,
          sha256: sha,
          fields: ['client.fullName', 'matter.number'],
          warnings: [],
          uploadedAt: FIXED_INSTANT,
          uploadedBy: TEST_UID,
        },
      ],
    },
    o,
  );

export const makeChecklistTemplate = (o: Partial<D.ChecklistTemplate> = {}) =>
  build(
    D.ChecklistTemplate,
    {
      name: 'Probate kick-off',
      items: ['Order the death certificate', 'Locate the original will', 'Search the will bank'],
      priority: 'high',
      dueInDays: 7,
    },
    o,
  );

export const makeTaskGroupTemplate = (o: Partial<D.TaskGroupTemplate> = {}) =>
  build(
    D.TaskGroupTemplate,
    {
      name: 'Checklist A',
      tasks: [
        { title: 'Locate the original will', checklist: ['Ask the family', 'Search the will bank'], priority: 'high' },
        { title: 'Write to the bank', checklist: [], dueInDays: 7 },
      ],
    },
    o,
  );

export const makeMetrics = (o: Partial<D.Metrics> = {}) =>
  build(D.Metrics, { period: 'month-2026-10', values: { 'matters.opened': 3, 'wip.timeCents': 125000 } }, o);

export const makeMemberMetrics = (o: Partial<D.MemberMetrics> = {}) =>
  build(D.MemberMetrics, { period: 'month-2026-10', uid: TEST_UID, values: { 'time.minutes': 360 } }, o);

export const makeMetricsShard = (o: Partial<D.MetricsShard> = {}) =>
  build(D.MetricsShard, { period: 'month-2026-10', shard: 3, values: { 'time.minutes': 60 } }, o);

export const makeMetricsLedger = (o: Partial<D.MetricsLedger> = {}) =>
  build(
    D.MetricsLedger,
    {
      orgId: TEST_ORG_ID,
      matterId: TEST_MATTER_ID,
      kind: 'time',
      sourceId: 'time-entry-1',
      counted: { '2026-10-06': { 'time.minutes': 60 }, [`2026-10-06|${TEST_UID}`]: { 'time.minutes': 60 } },
    },
    o,
  );

export const makeAuditEntry = (o: Partial<D.AuditEntry> = {}) =>
  build(
    D.AuditEntry,
    {
      at: FIXED_INSTANT,
      actor: { uid: TEST_UID },
      action: 'update',
      entity: { path: `orgs/${TEST_ORG_ID}/matters/${TEST_MATTER_ID}`, collection: 'matters', id: TEST_MATTER_ID },
      changedFields: ['status'],
      before: { status: 'open' },
      after: { status: 'closed' },
      source: 'client',
      expireAt: new Date(FIXED_INSTANT.getTime() + 7 * 365 * 24 * 60 * 60 * 1000),
    },
    o,
  );

export const makeNotification = (o: Partial<D.Notification> = {}) =>
  build(
    D.Notification,
    {
      kind: 'task_assigned',
      taskId: 'task-test-1',
      recipientUid: TEST_UID,
      title: 'New task',
      body: 'You were assigned a task',
      link: '/tasks',
      channels: ['inapp'],
      priority: 'normal',
      readAt: null,
      summaryId: null,
    },
    o as never,
  );

export const makeIntegration = (o: Partial<D.Integration> = {}) =>
  build(
    D.Integration,
    {
      provider: 'microsoft',
      uid: TEST_UID,
      status: 'connected',
      scopes: ['Calendars.ReadWrite'],
      encryptedRefreshToken: 'ciphertext-placeholder',
      kmsKeyVersion: '1',
    },
    o,
  );

export const makeIntegrationStatus = (o: Partial<D.IntegrationStatus> = {}) =>
  build(
    D.IntegrationStatus,
    {
      provider: 'microsoft',
      level: 'user',
      uid: TEST_UID,
      status: 'connected',
      scopes: ['Calendars.ReadWrite'],
      account: { email: 'connected@example.test' },
      connectedAt: new Date('2026-10-06T00:00:00Z'),
      connectedBy: TEST_UID,
    },
    o,
  );

export const makeIntegrationState = (o: Partial<D.IntegrationState> = {}) =>
  build(
    D.IntegrationState,
    {
      provider: 'microsoft',
      level: 'user',
      uid: TEST_UID,
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'https://materia-v2-dev.web.app/integrations/callback/microsoft',
      returnTo: '/settings',
      expireAt: new Date('2026-10-06T00:10:00Z'),
    },
    o,
  );

export const makeXeroContactLink = (o: Partial<D.XeroContactLink> = {}) =>
  build(
    D.XeroContactLink,
    {
      tenantId: '7d0f3b1e-5a6c-4e2b-9f1d-2c3b4a5d6e7f',
      contactId: 'fake-cont-000001',
      clientContactIds: ['contact-1'],
      name: 'Fictional Client',
    },
    o,
  );

export const makeTrustSnapshot = (o: Partial<D.TrustSnapshot> = {}) =>
  build(
    D.TrustSnapshot,
    {
      matterId: 'matter-1',
      amountCents: 8_421_000,
      asAt: d('2026-10-02'),
      source: 'manual',
      sourceSystemName: 'In-house trust records',
      recordedBy: 'user-test-lawyer',
      recordedAt: FIXED_INSTANT,
    },
    o,
  );

export const makeSafeCustody = (o: Partial<D.SafeCustody> = {}) =>
  build(
    D.SafeCustody,
    {
      packetNo: 'SC-000001',
      testatorContactId: 'contact-test-4',
      testatorName: 'Fictional Testator',
      responsibleUid: 'user-test-lawyer',
      items: [{ kind: 'will', date: d('2019-02-14'), description: 'Will' }],
      location: { site: 'Geelong', cabinet: 'Safe A', slot: '2' },
      receivedOn: d('2019-03-01'),
      status: 'held',
      search: ['sc000001', 'fictional'],
      locationKey: 'geelong|safe a|00000002',
    },
    o,
  );

export const makeMigrationRun = (o: Partial<D.MigrationRun> = {}) =>
  build(
    D.MigrationRun,
    { runId: 'run-test-1', mode: 'rehearsal', status: 'succeeded', startedAt: FIXED_INSTANT, counts: { matters: 3 } },
    o,
  );

export const makeMigrationEnrichment = (o: Partial<D.MigrationEnrichment> = {}) =>
  build(
    D.MigrationEnrichment,
    {
      runId: 'run-test-1',
      status: 'awaiting_approval',
      phase: 'ingest',
      seq: 2,
      documents: ['m-test-1/d-test-1'],
      matters: ['m-test-1'],
      estimate: {
        documents: 1,
        pages: 12,
        ocrPages: 2,
        chars: 24_000,
        unreadable: 0,
        matters: 1,
        costCents: 12,
        model: 'claude-sonnet-5-5',
      },
      suggestedAllowanceCents: 500,
    },
    o,
  );

export const makeRuleSetVersion = (o: Partial<D.RuleSetVersion> = {}) =>
  build(
    D.RuleSetVersion,
    {
      ruleSetId: 'vic-illustrative',
      version: 1,
      jurisdiction: 'VIC',
      published: false,
      rules: [
        { id: 'example-rule', title: 'Illustrative rule', citation: 'Illustrative only', definition: { months: 6 } },
      ],
    },
    o,
  );

export const makeCalendar = (o: Partial<D.Calendar> = {}) =>
  build(
    D.Calendar,
    {
      jurisdiction: 'VIC',
      year: 2026,
      holidays: [{ date: d('2026-12-25'), name: 'Christmas Day' }],
      source: 'Fictional fixture',
    },
    o,
  );

export const makeJob = (o: Partial<D.Job> = {}) =>
  build(
    D.Job,
    {
      type: 'pdf.merge',
      input: { inputs: [{ storagePath: `orgs/${TEST_ORG_ID}/matters/${TEST_MATTER_ID}/documents/doc-1/v1` }] },
      target: { kind: 'matter', matterId: TEST_MATTER_ID, name: 'Court book draft', category: 'court_document' },
      status: 'running',
      progress: { done: 2, total: 5, stage: 'merging' },
      attempts: 1,
      startedAt: FIXED_INSTANT,
      heartbeatAt: FIXED_INSTANT,
    },
    o,
  );

export const makeCounter = (o: Partial<D.Counter> = {}) => build(D.Counter, { next: 1 }, o);

export const makeMatterNumber = (o: Partial<D.MatterNumber> = {}) =>
  build(D.MatterNumber, { number: 'M-2026-0001', matterId: TEST_MATTER_ID, year: 2026 }, o);

export const makeSavedView = (o: Partial<D.SavedView> = {}) =>
  build(
    D.SavedView,
    {
      orgId: TEST_ORG_ID,
      list: 'matters',
      name: 'My urgent probates',
      filters: { status: ['open'], type: ['probate'], responsible: 'me' },
      sort: { field: 'lastActivity', dir: 'desc' },
      groupBy: 'none',
    },
    o,
  );

export const makeConflictCheck = (o: Partial<D.ConflictCheck> = {}) =>
  build(
    D.ConflictCheck,
    {
      subjects: [{ kind: 'person', name: 'Ada Quill', role: 'client' }],
      hits: [
        {
          subject: 0,
          contactId: 'contact-test-1',
          displayName: 'Ada Quill',
          score: 0.92,
          reasons: ['name'],
          matters: [
            {
              matterId: TEST_MATTER_ID,
              number: 'M-2026-0001',
              title: 'Estate of Bertram Quill',
              status: 'open',
              type: 'probate',
              role: 'beneficiary',
            },
          ],
        },
      ],
      ranAt: FIXED_INSTANT,
      ranBy: TEST_UID,
      adverseRolesChecked: false,
    },
    o,
  );

export const makeIntakeDraft = (o: Partial<D.IntakeDraft> = {}) =>
  build(
    D.IntakeDraft,
    {
      orgId: TEST_ORG_ID,
      kind: 'intake',
      step: 'details',
      stateJson: JSON.stringify({ type: { type: 'probate', jurisdiction: 'VIC' } }),
      expireAt: D.intakeDraftExpireAt(FIXED_INSTANT),
    },
    o,
  );

export const makeDestructionRequest = (o: Partial<D.DestructionRequest> = {}) =>
  build(
    D.DestructionRequest,
    {
      matterId: TEST_MATTER_ID,
      number: 'M-2018-0001',
      type: 'probate',
      closedAt: FIXED_INSTANT,
      destroyAfter: d('2025-10-01'),
      status: 'pending',
      queuedAt: FIXED_INSTANT,
    },
    o,
  );

export const makeDestructionCertificate = (o: Partial<D.DestructionCertificate> = {}) =>
  build(
    D.DestructionCertificate,
    {
      matterId: TEST_MATTER_ID,
      number: 'M-2018-0001',
      type: 'probate',
      closedAt: FIXED_INSTANT,
      destroyAfter: d('2025-10-01'),
      approvedBy: TEST_UID,
      approvedAt: FIXED_INSTANT,
      destroyedAt: FIXED_INSTANT,
      counts: { files: 2, documents: 1, records: 12 },
      storagePath: 'orgs/org-test-1/certificates/dc-matter-test-1.pdf',
      sha256: 'a'.repeat(64),
    },
    o,
  );

export const makeDeletedOrg = (o: Partial<D.DeletedOrg> = {}) =>
  build(
    D.DeletedOrg,
    {
      orgId: TEST_ORG_ID,
      name: 'Fictional Test Legal',
      status: 'deleted',
      stage: 'certificate',
      requestedBy: TEST_UID,
      requestedAt: FIXED_INSTANT,
      scheduledFor: FIXED_INSTANT,
      purgeStartedAt: FIXED_INSTANT,
      deletedAt: FIXED_INSTANT,
      certificateId: 'odc-0123456789ab',
      ownerUids: [TEST_UID],
      counts: { records: 120, files: 4, integrations: 0, members: 2 },
    },
    o,
  );

export const makeRecentMatter = (o: Partial<D.RecentMatter> = {}) =>
  build(
    D.RecentMatter,
    { orgId: TEST_ORG_ID, matterId: TEST_MATTER_ID, expireAt: D.recentMatterExpireAt(FIXED_INSTANT) },
    o,
  );

export const makeConnectorConnection = (o: Partial<D.ConnectorConnection> = {}) =>
  build(
    D.ConnectorConnection,
    {
      uid: TEST_UID,
      clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
      clientName: 'Claude',
      scopes: ['materia.read', 'materia.propose'],
      status: 'active',
      authTime: new Date('2026-10-06T00:00:00Z'),
      connectedAt: new Date('2026-10-06T00:01:00Z'),
    },
    o,
  );

export const makeConnectorGrant = (o: Partial<D.ConnectorGrant> = {}) =>
  build(
    D.ConnectorGrant,
    {
      kind: 'access',
      connectionId: 'connection-1',
      uid: TEST_UID,
      clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
      scopes: ['materia.read'],
      resource: 'https://materia-v2-dev.web.app/mcp',
      expireAt: new Date('2026-10-06T01:00:00Z'),
    },
    o,
  );

/** Every factory with its entity, for exhaustive tests (schema coverage, converter round-trips). */
export const ENTITY_FACTORIES = {
  Org: [D.Org, makeOrg],
  Member: [D.Member, makeMember],
  Invite: [D.Invite, makeInvite],
  User: [D.User, makeUser],
  Device: [D.Device, makeDevice],
  Timer: [D.Timer, makeTimer],
  Contact: [D.Contact, makeContact],
  Matter: [D.Matter, makeMatter],
  Party: [D.Party, makeParty],
  Task: [D.Task, makeTask],
  PersonalTask: [D.PersonalTask, makePersonalTask],
  MatterEvent: [D.MatterEvent, makeMatterEvent],
  Deadline: [D.Deadline, makeDeadline],
  DeadlineChange: [D.DeadlineChange, makeDeadlineChange],
  MatterDocument: [D.MatterDocument, makeMatterDocument],
  DocumentHash: [D.DocumentHash, makeDocumentHash],
  Chunk: [D.Chunk, makeChunk],
  Note: [D.Note, makeNote],
  NoteRevision: [D.NoteRevision, makeNoteRevision],
  Activity: [D.Activity, makeActivity],
  TimeEntry: [D.TimeEntry, makeTimeEntry],
  Disbursement: [D.Disbursement, makeDisbursement],
  Asset: [D.Asset, makeAsset],
  Liability: [D.Liability, makeLiability],
  Distribution: [D.Distribution, makeDistribution],
  Suggestion: [D.Suggestion, makeSuggestion],
  FactCitation: [D.FactCitation, makeFactCitation],
  MatterBrief: [D.MatterBrief, makeMatterBrief],
  ClerkThread: [D.ClerkThread, makeClerkThread],
  ClerkMessage: [D.ClerkMessage, makeClerkMessage],
  ClerkDraft: [D.ClerkDraft, makeClerkDraft],
  Proceeding: [D.Proceeding, makeProceeding],
  CourtEvent: [D.CourtEvent, makeCourtEvent],
  CourtOrder: [D.CourtOrder, makeCourtOrder],
  ChronologyEntry: [D.ChronologyEntry, makeChronologyEntry],
  Issue: [D.Issue, makeIssue],
  Evidence: [D.Evidence, makeEvidence],
  Subpoena: [D.Subpoena, makeSubpoena],
  Offer: [D.Offer, makeOffer],
  CourtBook: [D.CourtBook, makeCourtBook],
  Invoice: [D.Invoice, makeInvoice],
  CreditNote: [D.CreditNote, makeCreditNote],
  InvoiceReminder: [D.InvoiceReminder, makeInvoiceReminder],
  MatterTemplate: [D.MatterTemplate, makeMatterTemplate],
  MatterTemplateVersion: [D.MatterTemplateVersion, makeMatterTemplateVersion],
  DocTemplate: [D.DocTemplate, makeDocTemplate],
  ChecklistTemplate: [D.ChecklistTemplate, makeChecklistTemplate],
  TaskGroupTemplate: [D.TaskGroupTemplate, makeTaskGroupTemplate],
  Metrics: [D.Metrics, makeMetrics],
  MemberMetrics: [D.MemberMetrics, makeMemberMetrics],
  MetricsShard: [D.MetricsShard, makeMetricsShard],
  MetricsLedger: [D.MetricsLedger, makeMetricsLedger],
  AuditEntry: [D.AuditEntry, makeAuditEntry],
  Notification: [D.Notification, makeNotification],
  Integration: [D.Integration, makeIntegration],
  IntegrationStatus: [D.IntegrationStatus, makeIntegrationStatus],
  IntegrationState: [D.IntegrationState, makeIntegrationState],
  ConnectorConnection: [D.ConnectorConnection, makeConnectorConnection],
  ConnectorGrant: [D.ConnectorGrant, makeConnectorGrant],
  XeroContactLink: [D.XeroContactLink, makeXeroContactLink],
  SafeCustody: [D.SafeCustody, makeSafeCustody],
  TrustSnapshot: [D.TrustSnapshot, makeTrustSnapshot],
  MigrationRun: [D.MigrationRun, makeMigrationRun],
  MigrationEnrichment: [D.MigrationEnrichment, makeMigrationEnrichment],
  RuleSetVersion: [D.RuleSetVersion, makeRuleSetVersion],
  Calendar: [D.Calendar, makeCalendar],
  Job: [D.Job, makeJob],
  Counter: [D.Counter, makeCounter],
  MatterNumber: [D.MatterNumber, makeMatterNumber],
  SavedView: [D.SavedView, makeSavedView],
  ConflictCheck: [D.ConflictCheck, makeConflictCheck],
  IntakeDraft: [D.IntakeDraft, makeIntakeDraft],
  RecentMatter: [D.RecentMatter, makeRecentMatter],
  DestructionRequest: [D.DestructionRequest, makeDestructionRequest],
  DestructionCertificate: [D.DestructionCertificate, makeDestructionCertificate],
  DeletedOrg: [D.DeletedOrg, makeDeletedOrg],
} as const;
