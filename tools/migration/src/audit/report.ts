import { domain } from '../domain.ts';
import { addHtml, emptyHtmlStats, type HtmlStats } from '../legacy/html.ts';
import {
  arr,
  cardKeyOf,
  docId,
  linkedCardKeys,
  obj,
  referencedUids,
  str,
  valuesAt,
  workflowIdOf,
  workflowRoles,
  type AuthSummary,
  type LegacyDoc,
  type LegacySnapshot,
} from '../legacy/snapshot.ts';
import {
  checkProfileCoverage,
  findWorkflowMapping,
  type MappingProfile,
  type ProfileCoverage,
  type WorkflowMapping,
} from '../profile.ts';
import type { ReadOnlyCheck } from './iam.ts';
import {
  addDueDate,
  dateShape,
  fieldHistogram,
  sortRecord,
  type DueDateStats,
  type FieldHistogram,
  type ShapeContext,
} from './shapes.ts';

const { matterNumberProblem, referrerIndustryFromText, uploadExtension } = domain;

/**
 * The MIG-01 audit report: counts and shapes of one user's legacy data, plus the names the user
 * will see anyway (workflows, swimlanes, labels, the org name candidate) and the names of other
 * users the data references. It never holds document content: no titles, descriptions,
 * comments, file names, client or referrer details. `auditSnapshot` is pure, so it is unit-tested
 * on the synthetic fixtures in `tools/migration/fixtures/legacy/`.
 */

export const REPORT_VERSION = 1;

/** The legacy upload allow-list (`storage.rules`, `hasAllowedAttachmentExtension`). */
export const LEGACY_ALLOWED_EXTENSIONS = [
  'pdf',
  'doc',
  'docx',
  'txt',
  'csv',
  'xlsx',
  'pptx',
  'msg',
  'eml',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'webp',
  'svg',
  'zip',
] as const;

/** The legacy attachment size limit, 25 MB. */
export const LEGACY_MAX_BYTES = 25 * 1024 * 1024;

export interface AuditOptions {
  generatedAt: string;
  source: { project: string; bucket: string };
  readOnly?: ReadOnlyCheck;
  /** Scope comes from the profile when given (and its coverage is checked); else owner-or-admin. */
  profile?: MappingProfile;
}

export interface NumberRange {
  count: number;
  /** Values that aren't numbers (null, '', strings). */
  nonNumeric: number;
  zero: number;
  negative: number;
  /** Values with a fractional part. */
  decimals: number;
  min: number | null;
  max: number | null;
  median: number | null;
}

export interface WorkflowReport {
  id: string;
  name: string;
  visibility: string | null;
  /** The user's roles on it (`users[uid].roles`, plus legacy `owner`). */
  roles: string[];
  inScope: boolean;
  scopeReason: string;
  mode?: 'matters' | 'personal_tasks' | 'exclude';
  otherMembers: number;
  cards: number;
  archived: number;
  swimlanes: { id: string; title: string; isDoneSwimlane: boolean | null; cards: number; archived: number }[];
  cardsInUnknownSwimlane: number;
  labels: { id: string; name: string; color: string | null; cards: number }[];
  unknownLabelIds: number;
  checklistItems: number;
  comments: number;
  history: number;
  attachments: { count: number; bytes: number };
  checklistTemplates: number;
  cardsWithFee: number;
  cardsBillable: number;
  cardsWithReferrer: number;
}

export interface Warning {
  code: string;
  count: number;
  message: string;
}

export interface AuditReport {
  version: typeof REPORT_VERSION;
  generatedAt: string;
  source: { project: string; bucket: string; readOnly?: ReadOnlyCheck };
  subject: { uid: string; profileExists: boolean };
  scope: { rule: 'profile' | 'owner_or_admin'; included: string[]; excluded: { name: string; reason: string }[] };
  counts: {
    workflows: { total: number; inScope: number; byVisibility: Record<string, number> };
    cards: { total: number; archived: number; active: number };
    checklists: number;
    checklistItems: number;
    comments: number;
    history: number;
    attachments: { count: number; bytes: number };
    checklistTemplates: number;
    referrers: number;
    dashboardItems: number;
    integrations: number;
    workspaces: number;
  };
  workflows: WorkflowReport[];
  fields: Record<string, FieldHistogram>;
  legacyFields: Record<string, number>;
  people: { uid: string; exists: boolean; name: string | null; references: Record<string, number> }[];
  billing: {
    billingType: Record<string, number>;
    billableStatus: Record<string, number>;
    postType: Record<string, number>;
    splitFees: Record<string, number>;
  };
  money: {
    feeValue: NumberRange;
    billedFees: NumberRange;
    realisedFees: NumberRange;
    billingTotal: NumberRange;
    ownershipPercentage: NumberRange;
    budgets: NumberRange;
    unit: { guess: 'dollars' | 'cents' | 'unclear'; reasons: string[] };
  };
  dates: {
    fields: Record<string, Record<string, number>>;
    dueDates: DueDateStats;
    updatedBeforeCreated: number;
  };
  html: { description: HtmlStats; comment: HtmlStats; history: HtmlStats };
  attachments: {
    count: number;
    bytes: number;
    maxBytes: number;
    overLegacyLimit: number;
    byMime: Record<string, number>;
    byExtension: Record<string, number>;
    untyped: number;
    notOnLegacyAllowList: Record<string, number>;
    notOnV2AllowList: Record<string, number>;
    sizeMismatch: number;
  };
  orphans: {
    /** Attachment docs (paths: ids only) whose Storage object is missing. */
    attachmentsWithoutObject: string[];
    objectsWithoutDoc: { count: number; bytes: number; byKind: Record<string, number> };
    linkedCards: { total: number; migrated: number; inExcludedWorkflow: number; elsewhere: number; missing: number };
    referrerIdsWithoutReferrer: number;
  };
  ids: {
    cardIds: Record<string, number>;
    cardIdFieldMismatch: number;
    cardWorkflowIdMismatch: number;
    templateIdMismatch: number;
  };
  membership: { duplicateUids: number; uidsUsersDrift: number };
  matterReference: {
    set: number;
    null: number;
    empty: number;
    missing: number;
    /** Distinct references used by more than one card (case-insensitive). */
    duplicates: number;
    invalidAsNumber: number;
    maxLength: number;
    shapes: Record<string, number>;
  };
  titles: { empty: number; needsTrim: number; maxLength: number };
  priorities: {
    cards: Record<string, number>;
    checklistItems: Record<string, number>;
    dashboardItems: Record<string, number>;
  };
  referrers: {
    total: number;
    person: number;
    organisation: number;
    neither: number;
    industries: Record<string, number>;
    phones: Record<string, number>;
    emails: Record<string, number>;
    withoutTimestamps: number;
    usedByCards: number;
  };
  profile: {
    exists: boolean;
    /** The org name candidate (Legacy migration plan: `companyName`, else "{name}'s practice"). */
    companyName: string | null;
    hasBudgetFields: boolean;
    profileImage: boolean;
  };
  auth: AuthSummary | null;
  integrations: Record<string, number>;
  workspaces: { total: number; prime: number; nonPrime: string[] };
  dashboardItems: { total: number; checked: number };
  calendar: { linkedChecklistItems: number; legacyCalendarSync: number };
  profileCoverage?: ProfileCoverage;
  warnings: Warning[];
}

// ---------- helpers ----------

function bump(record: Record<string, number>, key: string, by = 1) {
  record[key] = (record[key] ?? 0) + by;
}

export function numberRange(values: readonly unknown[]): NumberRange {
  const numbers = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  const mid = Math.floor(numbers.length / 2);
  const at = (index: number) => numbers[index] ?? 0;
  const median = numbers.length ? (numbers.length % 2 ? at(mid) : (at(mid - 1) + at(mid)) / 2) : null;
  return {
    count: numbers.length,
    nonNumeric: values.filter((v) => v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))).length,
    zero: numbers.filter((n) => n === 0).length,
    negative: numbers.filter((n) => n < 0).length,
    decimals: numbers.filter((n) => !Number.isInteger(n)).length,
    min: numbers.length ? at(0) : null,
    max: numbers.length ? at(numbers.length - 1) : null,
    median,
  };
}

/** Whether legacy amounts are dollars or cents: the code says dollars; the data can contradict it. */
export function feeUnit(fee: NumberRange): AuditReport['money']['unit'] {
  const reasons = [
    'The legacy fee form takes dollars with up to 2 decimal places and shows "$" + value (fees.component.ts, fees-badge.component.ts).',
  ];
  if (fee.decimals > 0) {
    reasons.push(
      `${fee.decimals} ${fee.decimals === 1 ? 'amount has' : 'amounts have'} a fractional part, which cent amounts never would.`,
    );
    return { guess: 'dollars', reasons };
  }
  if (fee.median === null) {
    reasons.push('No fee amounts to check against.');
    return { guess: 'dollars', reasons };
  }
  if (fee.median < 100_000) {
    reasons.push(`The median amount is ${fee.median}: a plausible fee in dollars, and under $1,000 if it were cents.`);
    return { guess: 'dollars', reasons };
  }
  reasons.push(
    `The median amount is ${fee.median} with no fractional amounts, which could be cents: check before transforming.`,
  );
  return { guess: 'unclear', reasons };
}

function referenceShape(ref: string): string {
  if (/^\d+$/.test(ref)) return 'digits';
  if (/^[A-Za-z0-9]+$/.test(ref)) return 'alphanumeric';
  if (/^[A-Za-z0-9][A-Za-z0-9 ./_-]*$/.test(ref)) return 'code-with-separators';
  return 'other';
}

function phoneShape(phone: unknown): string {
  if (phone === undefined) return 'missing';
  if (typeof phone !== 'string' || !phone.trim()) return 'empty';
  const digits = phone.replace(/[\s()-]/g, '');
  if (/^(\+?61|0)4\d{8}$/.test(digits)) return 'au-mobile';
  if (/^(\+?61|0)[2378]\d{8}$/.test(digits)) return 'au-landline';
  if (/^1[38]00\d{6}$|^13\d{4}$/.test(digits)) return 'au-service';
  if (/^\+\d{8,15}$/.test(digits)) return 'international';
  return 'unrecognised';
}

function emailShape(email: unknown): string {
  if (email === undefined) return 'missing';
  if (typeof email !== 'string' || !email.trim()) return 'empty';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? 'valid' : 'invalid';
}

function objectKind(name: string): string {
  if (/^workflows\/[^/]+\/cards\/[^/]+\/attachments\//.test(name)) return 'card-attachment';
  if (/^workflows\/[^/]+\/attachments\//.test(name)) return 'workflow-attachment';
  if (name.startsWith('profile-images/')) return 'profile-image';
  return 'other';
}

function extensionOf(attachment: LegacyDoc): string {
  const field = str(attachment.data['fileExtension'])?.replace(/^\./, '').toLowerCase();
  if (field) return field;
  const path = str(attachment.data['storagePath']) ?? '';
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') ? path.slice(dot + 1).toLowerCase() : '';
}

const DATE_FIELDS: Record<string, [keyof LegacySnapshot, string]> = {
  'workflows.createdOn': ['workflows', 'createdOn'],
  'workflows.updatedOn': ['workflows', 'updatedOn'],
  'cards.createdOn': ['cards', 'createdOn'],
  'cards.updatedOn': ['cards', 'updatedOn'],
  'cards.dueDate': ['cards', 'dueDate'],
  'cards.checklists[].items[].dueDate': ['cards', 'checklists[].items[].dueDate'],
  'cards.checklists[].items[].doneOnDate': ['cards', 'checklists[].items[].doneOnDate'],
  'cards.comments[].date': ['cards', 'comments[].date'],
  'cards.comments[].editDate': ['cards', 'comments[].editDate'],
  'cards.history[].date': ['cards', 'history[].date'],
  'cards.billable.billingDate': ['cards', 'billable.billingDate'],
  'attachments.uploadedAt': ['attachments', 'uploadedAt'],
  'attachments.createdOn': ['attachments', 'createdOn'],
  'checklistTemplates.createdOn': ['checklistTemplates', 'createdOn'],
  'referrers.createdOn': ['referrers', 'createdOn'],
  'referrers.updatedOn': ['referrers', 'updatedOn'],
  'dashboardItems.dueDate': ['dashboardItems', 'dueDate'],
  'dashboardItems.doneOnDate': ['dashboardItems', 'doneOnDate'],
  'integrations.lastSyncDate': ['integrations', 'lastSyncDate'],
};

// ---------- the audit ----------

interface WorkflowScope {
  inScope: boolean;
  reason: string;
  roles: string[];
  mode?: WorkflowMapping['mode'];
}

/** In or out of the migration: the profile's mode when there is a profile, else whether the user owns or administers it. */
export function workflowScope(workflow: LegacyDoc, uid: string, profile: MappingProfile | undefined): WorkflowScope {
  const roles = workflowRoles(workflow.data, uid);
  if (profile) {
    const mapping = findWorkflowMapping(profile, { id: docId(workflow.path), name: str(workflow.data['name']) ?? '' });
    if (!mapping) return { inScope: false, reason: 'Not in the mapping profile', roles };
    if (mapping.mode === 'exclude') return { inScope: false, reason: mapping.reason, roles, mode: mapping.mode };
    const reason = mapping.mode === 'matters' ? 'Migrates as matters' : 'Migrates as personal tasks';
    return { inScope: true, reason, roles, mode: mapping.mode };
  }
  if (roles.includes('owner') || roles.includes('admin')) {
    return { inScope: true, reason: 'The user owns or administers it', roles };
  }
  return {
    inScope: false,
    reason: 'Shared board the user neither owns nor administers: decide whether to include it',
    roles,
  };
}

export function auditSnapshot(snapshot: LegacySnapshot, options: AuditOptions): AuditReport {
  const { uid, profile: profileDoc } = snapshot;
  const mappingProfile = options.profile;
  const ctx: ShapeContext = { uid, others: new Set(Object.keys(snapshot.people)) };

  const scopes = new Map(snapshot.workflows.map((w) => [docId(w.path), workflowScope(w, uid, mappingProfile)]));
  const inScope = (path: string) => scopes.get(workflowIdOf(path) ?? '')?.inScope === true;

  const workflows = snapshot.workflows.filter((w) => inScope(w.path));
  const cards = snapshot.cards.filter((c) => inScope(c.path));
  const attachments = snapshot.attachments.filter((a) => inScope(a.path));
  const templates = snapshot.checklistTemplates.filter((t) => inScope(t.path));
  const objectNames = new Set(snapshot.storageObjects.map((o) => o.name));
  const objectSize = new Map(snapshot.storageObjects.map((o) => [o.name, o.size]));

  // ---- per workflow (every workflow, in scope or not) ----
  const workflowReports: WorkflowReport[] = snapshot.workflows.map((workflow) => {
    const id = docId(workflow.path);
    const scope = scopes.get(id) ?? workflowScope(workflow, uid, mappingProfile);
    const own = snapshot.cards.filter((c) => workflowIdOf(c.path) === id);
    const ownAttachments = snapshot.attachments.filter((a) => workflowIdOf(a.path) === id);
    const lanes = arr(workflow.data['swimlanes']).map((lane) => obj(lane) ?? {});
    const laneIds = new Set(lanes.map((lane) => str(lane['id'])));
    const labels = arr(workflow.data['labels']).map((label) => obj(label) ?? {});
    const labelIds = new Set(labels.map((label) => str(label['id'])));
    const members = new Set([
      ...arr(workflow.data['uids']).filter((u): u is string => typeof u === 'string'),
      ...Object.keys(obj(workflow.data['users']) ?? {}),
    ]);
    members.delete(uid);
    return {
      id,
      name: str(workflow.data['name']) ?? '(unnamed)',
      visibility: str(workflow.data['visibility']) ?? null,
      roles: scope.roles,
      inScope: scope.inScope,
      scopeReason: scope.reason,
      ...(scope.mode ? { mode: scope.mode } : {}),
      otherMembers: members.size,
      cards: own.length,
      archived: own.filter((c) => c.data['archived'] === true).length,
      swimlanes: lanes.map((lane) => {
        const inLane = own.filter((c) => c.data['swimlaneId'] === lane['id']);
        return {
          id: str(lane['id']) ?? '',
          title: str(lane['title']) ?? '',
          isDoneSwimlane: typeof lane['isDoneSwimlane'] === 'boolean' ? lane['isDoneSwimlane'] : null,
          cards: inLane.length,
          archived: inLane.filter((c) => c.data['archived'] === true).length,
        };
      }),
      cardsInUnknownSwimlane: own.filter((c) => !laneIds.has(str(c.data['swimlaneId']))).length,
      labels: labels.map((label) => ({
        id: str(label['id']) ?? '',
        name: str(label['name']) ?? '',
        color: str(label['color']) ?? null,
        cards: own.filter((c) => arr(c.data['labelIds']).includes(label['id'])).length,
      })),
      unknownLabelIds: own.flatMap((c) => arr(c.data['labelIds'])).filter((l) => !labelIds.has(str(l))).length,
      checklistItems: own.flatMap((c) => valuesAt(c.data, 'checklists[].items[]')).length,
      comments: own.flatMap((c) => arr(c.data['comments'])).length,
      history: own.flatMap((c) => arr(c.data['history'])).length,
      attachments: {
        count: ownAttachments.length,
        bytes: ownAttachments.reduce((sum, a) => sum + (Number(a.data['sizeBytes']) || 0), 0),
      },
      checklistTemplates: snapshot.checklistTemplates.filter((t) => workflowIdOf(t.path) === id).length,
      cardsWithFee: own.filter((c) => obj(c.data['fee'])).length,
      cardsBillable: own.filter((c) => obj(c.data['billable'])).length,
      cardsWithReferrer: own.filter((c) => Boolean(str(c.data['referrerId']))).length,
    };
  });

  // ---- counts ----
  const byVisibility: Record<string, number> = {};
  for (const workflow of workflows) bump(byVisibility, str(workflow.data['visibility']) ?? '(none)');
  const attachmentBytes = attachments.reduce((sum, a) => sum + (Number(a.data['sizeBytes']) || 0), 0);
  const counts: AuditReport['counts'] = {
    workflows: { total: snapshot.workflows.length, inScope: workflows.length, byVisibility: sortRecord(byVisibility) },
    cards: {
      total: cards.length,
      archived: cards.filter((c) => c.data['archived'] === true).length,
      active: cards.filter((c) => c.data['archived'] !== true).length,
    },
    checklists: cards.flatMap((c) => arr(c.data['checklists'])).length,
    checklistItems: cards.flatMap((c) => valuesAt(c.data, 'checklists[].items[]')).length,
    comments: cards.flatMap((c) => arr(c.data['comments'])).length,
    history: cards.flatMap((c) => arr(c.data['history'])).length,
    attachments: { count: attachments.length, bytes: attachmentBytes },
    checklistTemplates: templates.length,
    referrers: snapshot.referrers.length,
    dashboardItems: snapshot.dashboardItems.length,
    integrations: snapshot.integrations.length,
    workspaces: snapshot.workspaces.length,
  };

  // ---- field histograms ----
  const data = (docs: LegacyDoc[]) => docs.map((d) => d.data);
  const fields: AuditReport['fields'] = {
    profile: fieldHistogram(profileDoc ? [profileDoc.data] : [], ctx),
    workspaces: fieldHistogram(data(snapshot.workspaces), ctx),
    workflows: fieldHistogram(data(workflows), ctx),
    cards: fieldHistogram(data(cards), ctx),
    attachments: fieldHistogram(data(attachments), ctx),
    checklistTemplates: fieldHistogram(data(templates), ctx),
    referrers: fieldHistogram(data(snapshot.referrers), ctx),
    dashboardItems: fieldHistogram(data(snapshot.dashboardItems), ctx),
    integrations: fieldHistogram(data(snapshot.integrations), ctx),
  };

  // ---- legacy field names ----
  const items = cards.flatMap((c) => valuesAt(c.data, 'checklists[].items[]')).map((i) => obj(i) ?? {});
  const fee = (key: string) => cards.filter((c) => key in (obj(c.data['fee']) ?? {})).length;
  const legacyFields: AuditReport['legacyFields'] = {
    'fee.realisedFees': fee('realisedFees'),
    'fee.hasDisbursements': fee('hasDisbursements'),
    'fee.disbursements': fee('disbursements'),
    'checklistItem.calendarSync': items.filter((i) => 'calendarSync' in i).length,
    'checklist.templateExists': cards
      .flatMap((c) => arr(c.data['checklists']))
      .filter((l) => 'templateExists' in (obj(l) ?? {})).length,
    'workflows.owner': workflows.filter((w) => 'owner' in w.data).length,
    'card.dueDate (set)': cards.filter((c) => Boolean(str(c.data['dueDate']))).length,
    'card.hoursEstimate (set)': cards.filter((c) => typeof c.data['hoursEstimate'] === 'number').length,
    'card.actualHours (set)': cards.filter((c) => typeof c.data['actualHours'] === 'number').length,
  };

  // ---- people ----
  const people = [...referencedUids({ uid, workflows, cards, attachments }).entries()]
    .map(([other, refs]) => ({
      uid: other,
      exists: snapshot.people[other]?.exists ?? false,
      name: snapshot.people[other]?.name ?? null,
      references: sortRecord(refs as Record<string, number>),
    }))
    .sort((a, b) => a.uid.localeCompare(b.uid));

  // ---- billing ----
  const billing: AuditReport['billing'] = { billingType: {}, billableStatus: {}, postType: {}, splitFees: {} };
  for (const card of cards) {
    const cardFee = obj(card.data['fee']);
    const billable = obj(card.data['billable']);
    bump(billing.billingType, cardFee ? str(cardFee['billingType']) || '(empty)' : '(no fee)');
    bump(billing.billableStatus, billable ? str(billable['status']) || '(empty)' : '(not billable)');
    if (billable) bump(billing.postType, str(billable['postType']) || '(none)');
    if (cardFee) bump(billing.splitFees, String(cardFee['splitFees'] ?? '(missing)'));
  }
  for (const key of Object.keys(billing) as (keyof typeof billing)[]) billing[key] = sortRecord(billing[key]);

  // ---- money ----
  const fieldOf = (field: string, key: string) =>
    cards.flatMap((c) => {
      const value = obj(c.data[field]);
      return value ? [value[key]] : [];
    });
  const feeValues = (key: string) => fieldOf('fee', key);
  const feeValue = numberRange(feeValues('value'));
  const money: AuditReport['money'] = {
    feeValue,
    billedFees: numberRange(feeValues('billedFees')),
    realisedFees: numberRange(feeValues('realisedFees')),
    billingTotal: numberRange(fieldOf('billable', 'billingTotal')),
    ownershipPercentage: numberRange(feeValues('ownershipPercentage')),
    budgets: numberRange(
      ['currentFinancialYearBudget', 'previousFinancialYearBudget'].map((key) => profileDoc?.data[key]),
    ),
    unit: feeUnit(feeValue),
  };

  // ---- dates ----
  const scoped: Record<string, LegacyDoc[]> = {
    workflows,
    cards,
    attachments,
    checklistTemplates: templates,
    referrers: snapshot.referrers,
    dashboardItems: snapshot.dashboardItems,
    integrations: snapshot.integrations,
  };
  const dateFields: Record<string, Record<string, number>> = {};
  for (const [label, [collection, path]] of Object.entries(DATE_FIELDS)) {
    const counts: Record<string, number> = {};
    for (const doc of scoped[collection] ?? [])
      for (const value of valuesAt(doc.data, path)) bump(counts, dateShape(value));
    dateFields[label] = sortRecord(counts);
  }
  const dueDates: DueDateStats = { melbourneMidnight: 0, utcMidnight: 0, otherTime: 0, differsFromUtc: 0 };
  for (const item of items) addDueDate(dueDates, item['dueDate']);
  for (const item of snapshot.dashboardItems) addDueDate(dueDates, item.data['dueDate']);
  const updatedBeforeCreated = Object.values(scoped)
    .flat()
    .filter((doc) => {
      const created = Date.parse(str(doc.data['createdOn']) ?? '');
      const updated = Date.parse(str(doc.data['updatedOn']) ?? '');
      return !Number.isNaN(created) && !Number.isNaN(updated) && updated < created;
    }).length;

  // ---- html ----
  const html = { description: emptyHtmlStats(), comment: emptyHtmlStats(), history: emptyHtmlStats() };
  for (const card of cards) {
    addHtml(html.description, card.data['description']);
    for (const value of valuesAt(card.data, 'comments[].comment')) addHtml(html.comment, value);
    for (const value of valuesAt(card.data, 'history[].action.description')) addHtml(html.history, value);
  }

  // ---- attachments ----
  const attachmentReport: AuditReport['attachments'] = {
    count: attachments.length,
    bytes: attachmentBytes,
    maxBytes: 0,
    overLegacyLimit: 0,
    byMime: {},
    byExtension: {},
    untyped: 0,
    notOnLegacyAllowList: {},
    notOnV2AllowList: {},
    sizeMismatch: 0,
  };
  const attachmentsWithoutObject: string[] = [];
  const referencedObjects = new Set<string>();
  for (const attachment of attachments) {
    const size = Number(attachment.data['sizeBytes']) || 0;
    const mime = str(attachment.data['mimeType']) ?? '';
    const ext = extensionOf(attachment);
    const storagePath = str(attachment.data['storagePath']) ?? '';
    attachmentReport.maxBytes = Math.max(attachmentReport.maxBytes, size);
    if (size > LEGACY_MAX_BYTES) attachmentReport.overLegacyLimit++;
    bump(attachmentReport.byMime, mime || '(none)');
    bump(attachmentReport.byExtension, ext || '(none)');
    if (!mime || mime === 'application/octet-stream') attachmentReport.untyped++;
    if (!(LEGACY_ALLOWED_EXTENSIONS as readonly string[]).includes(ext))
      bump(attachmentReport.notOnLegacyAllowList, ext || '(none)');
    if (!uploadExtension(`file.${ext}`)) bump(attachmentReport.notOnV2AllowList, ext || '(none)');
    if (storagePath) referencedObjects.add(storagePath);
    if (!storagePath || !objectNames.has(storagePath)) attachmentsWithoutObject.push(attachment.path);
    else if (objectSize.get(storagePath) !== size) attachmentReport.sizeMismatch++;
  }
  for (const key of ['byMime', 'byExtension', 'notOnLegacyAllowList', 'notOnV2AllowList'] as const) {
    attachmentReport[key] = sortRecord(attachmentReport[key]);
  }

  // ---- orphans ----
  const objectsWithoutDoc = { count: 0, bytes: 0, byKind: {} as Record<string, number> };
  for (const object of snapshot.storageObjects) {
    const kind = objectKind(object.name);
    if (kind === 'profile-image' || referencedObjects.has(object.name) || !inScope(object.name)) continue;
    objectsWithoutDoc.count++;
    objectsWithoutDoc.bytes += object.size;
    bump(objectsWithoutDoc.byKind, kind);
  }
  const cardKeys = new Map(snapshot.cards.map((c) => [cardKeyOf(c.path), c]));
  const linkedCards = { total: 0, migrated: 0, inExcludedWorkflow: 0, elsewhere: 0, missing: 0 };
  for (const card of cards) {
    for (const key of linkedCardKeys(card)) {
      linkedCards.total++;
      const target = cardKeys.get(key);
      if (target) {
        if (inScope(target.path)) linkedCards.migrated++;
        else linkedCards.inExcludedWorkflow++;
      } else if (snapshot.linkedCardsElsewhere[key]) linkedCards.elsewhere++;
      else linkedCards.missing++;
    }
  }
  const referrerIds = new Set(snapshot.referrers.map((r) => docId(r.path)));
  const usedReferrers = cards.map((c) => str(c.data['referrerId'])).filter((id): id is string => Boolean(id));

  // ---- ids and membership ----
  const cardIds: Record<string, number> = {};
  for (const card of cards) bump(cardIds, shapeOfId(docId(card.path)));
  const membership = { duplicateUids: 0, uidsUsersDrift: 0 };
  for (const workflow of workflows) {
    const uids = arr(workflow.data['uids']).filter((u): u is string => typeof u === 'string');
    const users = Object.keys(obj(workflow.data['users']) ?? {});
    if (new Set(uids).size !== uids.length) membership.duplicateUids++;
    const a = [...new Set(uids)].sort().join(',');
    const b = [...new Set(users)].sort().join(',');
    if (a !== b) membership.uidsUsersDrift++;
  }

  // ---- matter references and titles ----
  const matterReference: AuditReport['matterReference'] = {
    set: 0,
    null: 0,
    empty: 0,
    missing: 0,
    duplicates: 0,
    invalidAsNumber: 0,
    maxLength: 0,
    shapes: {},
  };
  const refCounts = new Map<string, number>();
  for (const card of cards) {
    const ref = card.data['matterReference'];
    if (ref === undefined) matterReference.missing++;
    else if (ref === null) matterReference.null++;
    else if (typeof ref !== 'string' || !ref.trim()) matterReference.empty++;
    else {
      matterReference.set++;
      matterReference.maxLength = Math.max(matterReference.maxLength, ref.trim().length);
      bump(matterReference.shapes, referenceShape(ref.trim()));
      if (matterNumberProblem(ref)) matterReference.invalidAsNumber++;
      const key = ref.trim().toUpperCase();
      refCounts.set(key, (refCounts.get(key) ?? 0) + 1);
    }
  }
  matterReference.duplicates = [...refCounts.values()].filter((n) => n > 1).length;
  matterReference.shapes = sortRecord(matterReference.shapes);
  const titles = { empty: 0, needsTrim: 0, maxLength: 0 };
  for (const card of cards) {
    const title = str(card.data['title']) ?? '';
    if (!title.trim()) titles.empty++;
    else if (title !== title.trim()) titles.needsTrim++;
    titles.maxLength = Math.max(titles.maxLength, title.trim().length);
  }

  // ---- priorities ----
  const priorityCounts = (values: unknown[]) => {
    const out: Record<string, number> = {};
    for (const value of values) bump(out, value === undefined ? 'missing' : String(value));
    return sortRecord(out);
  };

  // ---- referrers ----
  const referrers: AuditReport['referrers'] = {
    total: snapshot.referrers.length,
    person: 0,
    organisation: 0,
    neither: 0,
    industries: {},
    phones: {},
    emails: {},
    withoutTimestamps: 0,
    usedByCards: new Set(usedReferrers.filter((id) => referrerIds.has(id))).size,
  };
  for (const referrer of snapshot.referrers) {
    const name = str(referrer.data['name'])?.trim();
    const company = str(referrer.data['company'])?.trim();
    if (name) referrers.person++;
    else if (company) referrers.organisation++;
    else referrers.neither++;
    bump(referrers.industries, referrerIndustryFromText(str(referrer.data['industry'])) ?? '(none)');
    bump(referrers.phones, phoneShape(referrer.data['phone']));
    bump(referrers.emails, emailShape(referrer.data['email']));
    if (!str(referrer.data['createdOn'])) referrers.withoutTimestamps++;
  }
  referrers.industries = sortRecord(referrers.industries);
  referrers.phones = sortRecord(referrers.phones);
  referrers.emails = sortRecord(referrers.emails);

  // ---- profile, integrations, workspaces, dashboard, calendar ----
  const integrations: Record<string, number> = {};
  for (const integration of snapshot.integrations) {
    const key = `${str(integration.data['type']) ?? '(none)'}/${str(integration.data['provider']) ?? '(none)'}`;
    bump(integrations, key);
  }
  const nonPrime = snapshot.workspaces.filter((w) => w.data['isPrime'] !== true);
  const calendar = {
    linkedChecklistItems: items.filter((i) =>
      Object.values(obj(i['calendarSyncByUser']) ?? {}).some((s) => obj(s)?.['isLinkedToCalendar'] === true),
    ).length,
    legacyCalendarSync: items.filter((i) => 'calendarSync' in i).length,
  };

  const report: AuditReport = {
    version: REPORT_VERSION,
    generatedAt: options.generatedAt,
    source: { ...options.source, ...(options.readOnly ? { readOnly: options.readOnly } : {}) },
    subject: { uid, profileExists: profileDoc !== null },
    scope: {
      rule: mappingProfile ? 'profile' : 'owner_or_admin',
      included: workflowReports.filter((w) => w.inScope).map((w) => w.name),
      excluded: workflowReports.filter((w) => !w.inScope).map((w) => ({ name: w.name, reason: w.scopeReason })),
    },
    counts,
    workflows: workflowReports,
    fields,
    legacyFields,
    people,
    billing,
    money,
    dates: { fields: dateFields, dueDates, updatedBeforeCreated },
    html,
    attachments: attachmentReport,
    orphans: {
      attachmentsWithoutObject: attachmentsWithoutObject.sort(),
      objectsWithoutDoc: { ...objectsWithoutDoc, byKind: sortRecord(objectsWithoutDoc.byKind) },
      linkedCards,
      referrerIdsWithoutReferrer: usedReferrers.filter((id) => !referrerIds.has(id)).length,
    },
    ids: {
      cardIds: sortRecord(cardIds),
      cardIdFieldMismatch: cards.filter((c) => c.data['id'] !== undefined && c.data['id'] !== docId(c.path)).length,
      cardWorkflowIdMismatch: cards.filter(
        (c) => c.data['workflowId'] !== undefined && c.data['workflowId'] !== workflowIdOf(c.path),
      ).length,
      templateIdMismatch: templates.filter((t) => t.data['id'] !== docId(t.path)).length,
    },
    membership,
    matterReference,
    titles,
    priorities: {
      cards: priorityCounts(cards.map((c) => c.data['priority'])),
      checklistItems: priorityCounts(items.map((i) => i['priority'])),
      dashboardItems: priorityCounts(snapshot.dashboardItems.map((d) => d.data['priority'])),
    },
    referrers,
    profile: {
      exists: profileDoc !== null,
      companyName: str(profileDoc?.data['companyName'])?.trim() || null,
      hasBudgetFields: Boolean(profileDoc && 'currentFinancialYearBudget' in profileDoc.data),
      profileImage: snapshot.storageObjects.some((o) => o.name.startsWith(`profile-images/${uid}`)),
    },
    auth: snapshot.auth ?? null,
    integrations: sortRecord(integrations),
    workspaces: {
      total: snapshot.workspaces.length,
      prime: snapshot.workspaces.length - nonPrime.length,
      nonPrime: nonPrime.map((w) => str(w.data['name']) ?? '(unnamed)'),
    },
    dashboardItems: {
      total: snapshot.dashboardItems.length,
      checked: snapshot.dashboardItems.filter((d) => d.data['checked'] === true).length,
    },
    calendar,
    ...(mappingProfile
      ? {
          profileCoverage: checkProfileCoverage(
            mappingProfile,
            workflowReports.map((w) => ({ id: w.id, name: w.name, swimlanes: w.swimlanes })),
          ),
        }
      : {}),
    warnings: [],
  };
  report.warnings = warningsFor(report);
  return report;
}

function shapeOfId(id: string): string {
  if (/^[A-Za-z0-9]{20}$/.test(id)) return 'auto-id';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return 'uuid';
  return 'other';
}

/** The findings MIG-02 and MIG-03 must handle, with stable codes. */
export function warningsFor(report: AuditReport): Warning[] {
  const warnings: Warning[] = [];
  const warn = (code: string, count: number, message: string) => {
    if (count > 0) warnings.push({ code, count, message });
  };
  const inScope = report.workflows.filter((w) => w.inScope);
  const sumShapes = (histogram: Record<string, number> | undefined, keys: string[]) =>
    keys.reduce((sum, key) => sum + (histogram?.[key] ?? 0), 0);
  const allDateShapes = Object.values(report.dates.fields);

  warn(
    'MIG_A_EXCLUDED_WORKFLOWS',
    report.scope.excluded.length,
    'Workflows left out of the migration: confirm each in the decision log.',
  );
  warn(
    'MIG_A_UNKNOWN_SWIMLANE',
    inScope.reduce((s, w) => s + w.cardsInUnknownSwimlane, 0),
    'Cards whose swimlane no longer exists: they import as open and need review.',
  );
  warn(
    'MIG_A_UNKNOWN_LABEL',
    inScope.reduce((s, w) => s + w.unknownLabelIds, 0),
    'Label ids on cards that the workflow no longer defines: dropped and reported.',
  );
  warn(
    'MIG_A_FOREIGN_ASSIGNEE',
    report.fields['cards']?.['assignee']?.shapes['uid:other'] ?? 0,
    'Cards assigned to another legacy user: the foreign-assignee policy applies.',
  );
  warn(
    'MIG_A_MISSING_PERSON',
    report.people.filter((p) => !p.exists).length,
    'Referenced users with no legacy profile: their names are unknown.',
  );
  warn(
    'MIG_A_TIMESTAMP_VALUES',
    allDateShapes.reduce((s, c) => s + (c['timestamp'] ?? 0), 0),
    'Date fields holding Firestore Timestamps instead of ISO strings.',
  );
  warn(
    'MIG_A_INVALID_DATES',
    allDateShapes.reduce((s, c) => s + sumShapes(c, ['invalid', 'other-parseable', 'number']), 0),
    'Date fields that are not ISO strings: they import as the load time with a warning.',
  );
  warn(
    'MIG_A_UPDATED_BEFORE_CREATED',
    report.dates.updatedBeforeCreated,
    'Documents whose updatedOn is earlier than their createdOn.',
  );
  warn(
    'MIG_A_INLINE_IMAGES',
    report.html.description.images.inlineBase64 + report.html.comment.images.inlineBase64,
    'Inline base64 images in rich text: the transform must extract or drop them.',
  );
  warn(
    'MIG_A_REMOTE_IMAGES',
    report.html.description.images.remote + report.html.comment.images.remote,
    'Remote images in rich text (possible tracking pixels): sanitising drops them.',
  );
  const unsafe = (stats: HtmlStats) => Object.values(stats.unsafe).reduce((a, b) => a + b, 0);
  warn(
    'MIG_A_UNSAFE_HTML',
    unsafe(report.html.description) + unsafe(report.html.comment),
    'Scripts, styles, frames, handlers or javascript: URLs in rich text: sanitising strips them.',
  );
  warn(
    'MIG_A_ORPHAN_ATTACHMENT',
    report.orphans.attachmentsWithoutObject.length,
    'Attachment documents whose Storage object is missing: reported, not fatal.',
  );
  warn(
    'MIG_A_ORPHAN_OBJECT',
    report.orphans.objectsWithoutDoc.count,
    'Storage objects no attachment document points at.',
  );
  warn(
    'MIG_A_BROKEN_LINK',
    report.orphans.linkedCards.missing +
      report.orphans.linkedCards.inExcludedWorkflow +
      report.orphans.linkedCards.elsewhere,
    'Linked cards that will not be migrated: the links are dropped and reported.',
  );
  warn(
    'MIG_A_MISSING_REFERRER',
    report.orphans.referrerIdsWithoutReferrer,
    'Cards whose referrerId names no referrer of the user.',
  );
  warn('MIG_A_LARGE_ATTACHMENT', report.attachments.overLegacyLimit, 'Attachments over the legacy 25 MB limit.');
  warn(
    'MIG_A_TYPE_NOT_ON_V2_LIST',
    Object.values(report.attachments.notOnV2AllowList).reduce((a, b) => a + b, 0),
    'Attachments whose type v2 uploads do not accept: decide how they import.',
  );
  warn(
    'MIG_A_UNTYPED_ATTACHMENT',
    report.attachments.untyped,
    'Attachments with no content type: the type comes from the extension.',
  );
  warn(
    'MIG_A_SIZE_MISMATCH',
    report.attachments.sizeMismatch,
    'Attachments whose recorded size differs from the Storage object.',
  );
  warn(
    'MIG_A_LEGACY_FIELDS',
    [
      'fee.realisedFees',
      'fee.hasDisbursements',
      'fee.disbursements',
      'checklistItem.calendarSync',
      'workflows.owner',
    ].reduce((s, k) => s + (report.legacyFields[k] ?? 0), 0),
    'Fields written by old app versions: the transform maps their legacy names.',
  );
  warn(
    'MIG_A_TEMPLATE_ID',
    report.ids.templateIdMismatch,
    'Checklist templates whose id field differs from the document id: the document id wins.',
  );
  warn(
    'MIG_A_MEMBERSHIP_DRIFT',
    report.membership.duplicateUids + report.membership.uidsUsersDrift,
    'Workflows whose uids repeat or differ from users: the union counts as members.',
  );
  warn(
    'MIG_A_DUPLICATE_REFERENCE',
    report.matterReference.duplicates,
    'Matter references used by more than one card: they cannot all become v2 numbers.',
  );
  warn(
    'MIG_A_EMPTY_TITLE',
    report.titles.empty,
    'Cards with no title: they import as "Untitled matter (imported)" for review.',
  );
  warn(
    'MIG_A_NO_BUDGET_FIELDS',
    report.profile.exists && !report.profile.hasBudgetFields ? 1 : 0,
    'The profile predates FY budgets (before legacy commit 64b3316): no budgets migrate.',
  );
  warn('MIG_A_NON_PRIME_WORKSPACE', report.workspaces.nonPrime.length, 'Non-prime workspaces: none were expected.');
  warn(
    'MIG_A_FEE_UNIT_UNCLEAR',
    report.money.unit.guess === 'unclear' ? 1 : 0,
    'Fee amounts could be dollars or cents: confirm before transforming.',
  );
  warn(
    'MIG_A_CALENDAR_LINKED',
    report.calendar.linkedChecklistItems + report.calendar.legacyCalendarSync,
    'Checklist items synced to a calendar: those events stay in the calendar after migration.',
  );
  if (report.profileCoverage && !report.profileCoverage.ok) {
    const c = report.profileCoverage;
    warn(
      'MIG_A_PROFILE_INCOMPLETE',
      c.unmappedWorkflows.length + c.unknownWorkflows.length + c.unmappedSwimlanes.length + c.unknownSwimlanes.length,
      'The mapping profile does not match the data exactly: see profile coverage.',
    );
  }
  return warnings;
}
