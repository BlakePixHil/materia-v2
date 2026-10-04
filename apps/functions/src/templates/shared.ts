import {
  FieldValue,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { z } from 'zod';

import {
  DEFAULT_ORG_TIMEZONE,
  EventKindSchema,
  isSystemTemplateId,
  systemTemplate,
  Task,
  templateContentShape,
  templateTaskDocId,
  templateTaskFields,
  templateTasksFor,
  type AnchorContext,
  type AnchorEvent,
  type DateOnly,
  type FactMatter,
  type Template,
  type TemplateStageLike,
} from '@materia/domain';

import { isDeleted } from '../contacts/shared';
import { matterPath } from '../matters/shared';

/** Shared helpers for matter templates (CORE-07). */

export const templatesPath = (orgId: string) => `orgs/${orgId}/templates`;
export const templatePath = (orgId: string, templateId: string) => `${templatesPath(orgId)}/${templateId}`;
export const templateVersionPath = (orgId: string, templateId: string, version: number) =>
  `${templatePath(orgId, templateId)}/versions/${version}`;

type Data = Record<string, unknown>;
/** Reads a document: `tx.get` inside a transaction, `ref.get` outside. */
export type Read = (ref: DocumentReference) => Promise<DocumentSnapshot>;

export const readWith =
  (tx?: Transaction): Read =>
  (ref) =>
    tx ? tx.get(ref) : ref.get();

const ContentSchema = z.object(templateContentShape);

/** A stored template's content (draft, version), or undefined when it doesn't parse. */
function contentOf(data: Data | undefined) {
  const parsed = ContentSchema.safeParse(data ?? {});
  return parsed.success ? parsed.data : undefined;
}

/**
 * A template at a version, as matters use it: a system template from the bundle, an org
 * template's published version (`versions/{n}`), or, without a version, the org template's latest
 * published version. Undefined when it doesn't exist (or a system template's version differs).
 */
export async function readTemplate(
  db: Firestore,
  read: Read,
  orgId: string,
  templateId: string,
  version?: number,
): Promise<Template | undefined> {
  if (isSystemTemplateId(templateId)) {
    const found = systemTemplate(templateId);
    return found && (version === undefined || version === found.version) ? found : undefined;
  }
  let at = version;
  if (at === undefined) {
    const head = await read(db.doc(templatePath(orgId, templateId)));
    const latest = head.get('version');
    if (!head.exists || typeof latest !== 'number' || latest < 1) return undefined;
    at = latest;
  }
  const snap = await read(db.doc(templateVersionPath(orgId, templateId, at)));
  const content = snap.exists ? contentOf(snap.data()) : undefined;
  if (!content) return undefined;
  const basedOn = snap.get('basedOn') as Template['basedOn'];
  return { ...content, id: templateId, version: at, source: 'org', ...(basedOn ? { basedOn } : {}) };
}

/** Stages read leniently: `{ id, name }` (CORE-07) or `{ id, title }` (CORE-06), malformed ones skipped. */
function lenientStages(value: unknown): TemplateStageLike[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const stages = value.filter(
    (stage): stage is TemplateStageLike =>
      !!stage &&
      typeof stage.id === 'string' &&
      !!stage.id &&
      ((typeof stage.name === 'string' && !!stage.name) || (typeof stage.title === 'string' && !!stage.title)),
  );
  return stages.length ? stages : undefined;
}

/**
 * A matter's template stages for the stepper and `matters-changeStage`: the system template's, the
 * matter's version's, else the org template document's (CORE-06 documents too). Undefined when
 * the matter has no template or it can't be found: the type's default stages apply.
 */
export async function readMatterTemplateStages(
  db: Firestore,
  read: Read,
  orgId: string,
  matter: Data,
): Promise<TemplateStageLike[] | undefined> {
  const templateId = matter['templateId'];
  if (typeof templateId !== 'string' || !templateId) return undefined;
  if (isSystemTemplateId(templateId)) return systemTemplate(templateId)?.stages;
  const version = matter['templateVersion'];
  if (typeof version === 'number' && version >= 1) {
    const snap = await read(db.doc(templateVersionPath(orgId, templateId, version)));
    const stages = snap.exists ? lenientStages(snap.get('stages')) : undefined;
    if (stages) return stages;
  }
  const head = await read(db.doc(templatePath(orgId, templateId)));
  return head.exists ? lenientStages(head.get('stages')) : undefined;
}

/** The org's time zone (`orgs/{orgId}.timezone`), else the default. */
export async function orgTimeZone(db: Firestore, orgId: string): Promise<string> {
  const zone = (await db.doc(`orgs/${orgId}`).get()).get('timezone');
  return typeof zone === 'string' && zone ? zone : DEFAULT_ORG_TIMEZONE;
}

/** The first active paralegal (by uid), who gets `role:paralegal` template tasks. */
export async function firstActiveParalegal(db: Firestore, orgId: string): Promise<string | undefined> {
  const snap = await db
    .collection(`orgs/${orgId}/members`)
    .where('role', '==', 'paralegal')
    .where('status', '==', 'active')
    .get();
  return snap.docs.map((doc) => doc.id).sort()[0];
}

/** A matter's live events, for anchors and requirements. */
export async function readEvents(db: Firestore, tx: Transaction, orgId: string, matterId: string) {
  const snap = await tx.get(db.collection(`${matterPath(orgId, matterId)}/events`));
  return snap.docs
    .map((doc) => doc.data())
    .filter((data) => !isDeleted(data))
    .flatMap((data): AnchorEvent[] => {
      const kind = EventKindSchema.safeParse(data['kind']);
      return kind.success && typeof data['date'] === 'string' ? [{ kind: kind.data, date: data['date'] }] : [];
    });
}

export function anchorContext(matter: Data, events: readonly AnchorEvent[]): AnchorContext {
  return { matter: matter as FactMatter, events };
}

export interface TaskPlanOptions {
  orgId: string;
  matterId: string;
  stageId: string;
  stageEnteredOn: DateOnly;
  /** Also create later stages' tasks whose anchor event is known (apply, create, upgrade). */
  knownAnchors: boolean;
  responsibleUid: string;
  paralegalUid?: string | undefined;
  uid: string;
  now: Date;
  requestId: string;
}

/** A task document to create. */
export interface PlannedTask {
  path: string;
  data: Data;
}

/** The template tasks a matter at `stageId` gets, as task documents (existing ones are filtered later). */
export function planTemplateTasks(template: Template, ctx: AnchorContext, options: TaskPlanOptions): PlannedTask[] {
  const base = `${matterPath(options.orgId, options.matterId)}/tasks`;
  return templateTasksFor(template, options.stageId, ctx, { knownAnchors: options.knownAnchors }).map((task) => ({
    path: `${base}/${templateTaskDocId(task.key)}`,
    data: Task.schema.parse({
      ...templateTaskFields(template, task, ctx, options),
      orgId: options.orgId,
      matterId: options.matterId,
      createdAt: options.now,
      createdBy: options.uid,
      updatedAt: options.now,
      updatedBy: options.uid,
      _requestId: options.requestId,
      schemaVersion: Task.version,
    }) as Data,
  }));
}

/**
 * Creates the planned tasks that don't exist yet (one per matter and template task key, so a
 * retry, a second apply or a soft-deleted task never duplicates one) and counts them on the
 * matter's `openTaskCount`. Reads first, so call it before any other write in the transaction;
 * returns a function that does the writes, and the ids it will create.
 */
export async function createMissingTasks(
  db: Firestore,
  tx: Transaction,
  matterRef: DocumentReference,
  planned: readonly PlannedTask[],
): Promise<{ ids: string[]; write: () => void }> {
  const snaps = await Promise.all(planned.map((task) => tx.get(db.doc(task.path))));
  const missing = planned.filter((_, i) => !snaps[i]?.exists);
  return {
    ids: missing.map((task) => task.path.split('/').at(-1) as string),
    write: () => {
      for (const task of missing) tx.create(db.doc(task.path), task.data);
      if (missing.length) tx.update(matterRef, { openTaskCount: FieldValue.increment(missing.length) });
    },
  };
}
