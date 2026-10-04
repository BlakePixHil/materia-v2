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
      security: { mfaRequired: true, sessionIdleMinutes: 30 },
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
  build(D.MatterEvent, { kind: 'date_of_death', date: d('2026-07-14') }, o);

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
      category: 'will',
      scan: { status: 'clean' },
      ingest: { status: 'done', pages: 4 },
      source: 'upload',
    },
    o,
  );

export const makeChunk = (o: Partial<D.Chunk> = {}) =>
  build(
    D.Chunk,
    {
      orgId: TEST_ORG_ID,
      matterId: TEST_MATTER_ID,
      text: 'I appoint my daughter Catherine Whitfield as executor.',
      page: 1,
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
      description: 'Probate filing fee (fictional amount)',
      amountExGstCents: 10000,
      gstCents: ZERO,
      gstTreatment: 'gst_free',
      payee: 'Court registry',
      status: 'draft',
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
      kind: 'task',
      payload: {
        title: 'Publish notice of intention to apply',
        status: 'todo',
        priority: 'medium',
        order: 2,
        checklist: [],
        source: 'clerk',
      },
      citations: [{ documentId: 'doc-test-1', page: 2, quote: 'I appoint my daughter' }],
      status: 'proposed',
      promptId: 'suggest-tasks',
      promptVersion: '1.0.0',
      model: 'claude-opus-5-5',
      dedupeKey: 'task:publish-notice',
    },
    o,
  );

export const makeClerkThread = (o: Partial<D.ClerkThread> = {}) =>
  build(D.ClerkThread, { title: 'Grant timeline', ownerUid: TEST_UID, matterId: TEST_MATTER_ID }, o);

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
      status: 'issued',
    },
    o,
  );

export const makeCreditNote = (o: Partial<D.CreditNote> = {}) =>
  build(
    D.CreditNote,
    {
      number: 'CN-000001',
      invoiceId: 'invoice-test-1',
      matterId: TEST_MATTER_ID,
      issueDate: d('2026-10-05'),
      reason: 'Fee reduction',
      lines: [{ ...line, amountExGstCents: -1000, gstCents: -100 }],
      totalCents: -1100,
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
    { name: 'Engagement letter', storagePath: `orgs/${TEST_ORG_ID}/docTemplates/engagement.docx` },
    o,
  );

export const makeMetrics = (o: Partial<D.Metrics> = {}) =>
  build(D.Metrics, { period: 'month-2026-10', values: { mattersOpened: 3, wipCents: 125000 } }, o);

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
      channel: ['inapp'],
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

export const makeSafeCustody = (o: Partial<D.SafeCustody> = {}) =>
  build(
    D.SafeCustody,
    {
      testatorContactId: 'contact-test-4',
      packetNo: '0000-TEST',
      location: 'Safe A, shelf 2',
      receivedOn: d('2019-03-01'),
      status: 'held',
    },
    o,
  );

export const makeMigrationRun = (o: Partial<D.MigrationRun> = {}) =>
  build(
    D.MigrationRun,
    { runId: 'run-test-1', mode: 'rehearsal', status: 'succeeded', startedAt: FIXED_INSTANT, counts: { matters: 3 } },
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

/** Every factory with its entity, for exhaustive tests (schema coverage, converter round-trips). */
export const ENTITY_FACTORIES = {
  Org: [D.Org, makeOrg],
  Member: [D.Member, makeMember],
  Invite: [D.Invite, makeInvite],
  User: [D.User, makeUser],
  Contact: [D.Contact, makeContact],
  Matter: [D.Matter, makeMatter],
  Party: [D.Party, makeParty],
  Task: [D.Task, makeTask],
  PersonalTask: [D.PersonalTask, makePersonalTask],
  MatterEvent: [D.MatterEvent, makeMatterEvent],
  Deadline: [D.Deadline, makeDeadline],
  MatterDocument: [D.MatterDocument, makeMatterDocument],
  Chunk: [D.Chunk, makeChunk],
  Note: [D.Note, makeNote],
  Activity: [D.Activity, makeActivity],
  TimeEntry: [D.TimeEntry, makeTimeEntry],
  Disbursement: [D.Disbursement, makeDisbursement],
  Asset: [D.Asset, makeAsset],
  Liability: [D.Liability, makeLiability],
  Distribution: [D.Distribution, makeDistribution],
  Suggestion: [D.Suggestion, makeSuggestion],
  ClerkThread: [D.ClerkThread, makeClerkThread],
  ClerkMessage: [D.ClerkMessage, makeClerkMessage],
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
  MatterTemplate: [D.MatterTemplate, makeMatterTemplate],
  MatterTemplateVersion: [D.MatterTemplateVersion, makeMatterTemplateVersion],
  DocTemplate: [D.DocTemplate, makeDocTemplate],
  Metrics: [D.Metrics, makeMetrics],
  AuditEntry: [D.AuditEntry, makeAuditEntry],
  Notification: [D.Notification, makeNotification],
  Integration: [D.Integration, makeIntegration],
  SafeCustody: [D.SafeCustody, makeSafeCustody],
  MigrationRun: [D.MigrationRun, makeMigrationRun],
  RuleSetVersion: [D.RuleSetVersion, makeRuleSetVersion],
  Calendar: [D.Calendar, makeCalendar],
  Job: [D.Job, makeJob],
  Counter: [D.Counter, makeCounter],
  MatterNumber: [D.MatterNumber, makeMatterNumber],
  SavedView: [D.SavedView, makeSavedView],
  ConflictCheck: [D.ConflictCheck, makeConflictCheck],
} as const;
