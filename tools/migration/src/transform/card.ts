import { domain } from '../domain.ts';
import { inlineImageDocument, inlineImageName, mapAttachments } from './attachments.ts';
import { mapChecklists } from './checklists.ts';
import { buildNote, mapComments, richText, type MatterRef } from './comments.ts';
import { buildContact, contactName } from './contact.ts';
import { migratedMeta, migId, type ReviewCode, type TransformContext, type TransformedRecord } from './context.ts';
import { createdAndUpdated } from './dates.ts';
import { mapFee, mapLegacyBilling } from './fee.ts';
import { mapHistory } from './history.ts';
import { cleanText, priorityOf, splitName } from './values.ts';
import { placeCard, type WorkflowPlan } from './workflow.ts';
import type { ExportRecord } from '../export/jsonl.ts';
import { docId, linkedCardKeys, str, type StorageObject } from '../legacy/snapshot.ts';

const { matterSearchTokens, systemTemplate } = domain;

/**
 * A card on a matters board → a matter (Legacy migration plan, "Card → matter") with everything
 * that hangs off it: its client contact (D-10), its notes (the description, the original
 * assignee, fee notes, the comments), tasks from its checklists, activity from its history, and
 * documents from its attachments and any images its description embedded. Linked cards resolve
 * to `relatedMatterIds` in a second pass, once every matter has its id.
 */

export const UNTITLED_MATTER = 'Untitled matter (imported)';
const CONFLICT_REASON = 'Opened before Materia (imported)';

export interface CardDeps {
  plan: WorkflowPlan;
  number: string;
  /** Legacy referrer id → v2 contact id. */
  referrers: ReadonlyMap<string, string>;
  subjectName: string;
  /** The card's attachment documents. */
  attachments: readonly ExportRecord[];
  objects: ReadonlyMap<string, StorageObject>;
}

export interface CardResult {
  matter: TransformedRecord;
  /** The client contact, notes, tasks, activity and documents. */
  records: TransformedRecord[];
  /** Linked cards as `{workflowId}/{cardId}`, for the second pass. */
  links: string[];
}

export function matterIdOf(cardPath: string): string {
  return migId(cardPath);
}

export function mapCard(ctx: TransformContext, card: ExportRecord, deps: CardDeps): CardResult {
  const data = card.data ?? {};
  const path = card.path;
  const matterId = matterIdOf(path);
  const { createdAt, updatedAt } = createdAndUpdated(ctx, data, path);
  const ref: MatterRef = { orgId: ctx.orgId, matterId, cardPath: path, createdAt, updatedAt };
  const review: ReviewCode[] = [];
  const records: TransformedRecord[] = [];

  // Title (trimmed; a placeholder when empty) and where the card sits.
  let title = cleanText(data['title']);
  if (!title) {
    title = UNTITLED_MATTER;
    review.push('title_missing');
    ctx.warnings.add('MIG_W_UNTITLED', path);
  }
  const placement = placeCard(deps.plan, data['swimlaneId']);
  if (placement.unknownLane) {
    review.push('swimlane_unknown');
    ctx.warnings.add('MIG_W_SWIMLANE_UNKNOWN', path);
  }
  const archived = data['archived'] === true;
  const status = archived ? 'archived' : placement.status;
  if (status === 'closed' || status === 'archived') review.push('closed_without_closing_record');

  // The client (D-10): v2 matters need one, and a card has only its title.
  const client = clientContact(ctx, path, title, createdAt, updatedAt);
  review.push(ctx.profile.matterDefaults.clientContact === 'from_title' ? 'client_from_title' : 'client_placeholder');
  records.push(client);

  // Who is responsible (D-07): always the user; someone else's card gets a note naming them.
  const assignee = str(data['assignee'])?.trim() ?? '';
  if (assignee && assignee !== ctx.uid) {
    ctx.warnings.add('MIG_W_ASSIGNEE_FOREIGN', path);
    if (ctx.profile.foreignAssignees === 'reassign_with_note') {
      const name = ctx.people.get(assignee) || 'a former colleague';
      records.push(
        buildNote(ctx, ref, {
          legacyPath: `${path}#original-assignee`,
          bodyMd: `**Assignee (imported)**\n\nThis matter was assigned to ${name} in the legacy app.`,
          createdAt,
          updatedAt: createdAt,
          authorUid: ctx.uid,
        }),
      );
    }
  }

  // The referrer (CORE-18): through the referrer map; `''` is none.
  const referrerId = str(data['referrerId'])?.trim() ?? '';
  const referrerContactId = referrerId ? deps.referrers.get(referrerId) : undefined;
  if (referrerId && !referrerContactId) ctx.warnings.add('MIG_W_REFERRER_MISSING', path);

  // Labels (D-05), and the board's.
  const labels = new Set<string>([deps.plan.boardLabel]);
  for (const labelId of Array.isArray(data['labelIds']) ? data['labelIds'] : []) {
    if (typeof labelId !== 'string') continue;
    if (!deps.plan.labels.has(labelId)) {
      ctx.warnings.add('MIG_W_LABEL_UNKNOWN', path);
      continue;
    }
    const label = deps.plan.labels.get(labelId);
    if (label) labels.add(label);
  }

  // Fee and legacy billing (D-06).
  const fee = mapFee(ctx, data['fee'], path);
  review.push(...fee.review);
  for (const note of fee.notes) {
    records.push(
      buildNote(ctx, ref, {
        legacyPath: `${path}#${note.key}`,
        bodyMd: note.text,
        createdAt,
        updatedAt: createdAt,
        authorUid: ctx.uid,
      }),
    );
  }
  const legacyBilling = mapLegacyBilling(ctx, data['billable'], path);

  // The description: a pinned note, with embedded images moved to documents.
  const description = richText(
    ctx,
    data['description'],
    path,
    (index, image) => `[Image moved to Documents: ${inlineImageName(index, image)}]`,
  );
  description.images.forEach((image, index) => records.push(inlineImageDocument(ctx, ref, image, index)));
  if (description.markdown) {
    records.push(
      buildNote(ctx, ref, {
        legacyPath: `${path}#description`,
        bodyMd: `**Description (imported)**\n\n${description.markdown}`,
        pinned: true,
        createdAt,
        updatedAt,
        authorUid: ctx.uid,
      }),
    );
  }

  records.push(...mapComments(ctx, ref, data['comments'], deps.subjectName));
  records.push(...mapChecklists(ctx, ref, data['checklists']));
  records.push(...mapHistory(ctx, ref, data['history']));
  records.push(...mapAttachments(ctx, ref, deps.attachments, deps.objects));

  const externalRef = cleanText(data['matterReference']);
  const template = systemTemplate(`system-${placement.type}`);
  const lead = status === 'lead';
  const closed = status === 'closed' || status === 'archived';
  const clientName = contactName(client);

  const matter: TransformedRecord = {
    entity: 'matters',
    path: `orgs/${ctx.orgId}/matters/${matterId}`,
    legacyPath: path,
    data: {
      number: deps.number,
      title,
      type: placement.type,
      status,
      ...(placement.stageId ? { stageId: placement.stageId } : {}),
      ...(template ? { templateId: template.id, templateVersion: template.version } : {}),
      jurisdiction: ctx.profile.org.jurisdiction,
      responsibleUid: ctx.uid,
      teamUids: [],
      clientContactIds: [docId(client.path)],
      ...(referrerContactId ? { referrerContactId } : {}),
      fee: fee.fee,
      costsDisclosure: {
        status:
          ctx.profile.matterDefaults.costsDisclosure === 'required_unless_closed' && !closed
            ? 'required'
            : 'not_required',
      },
      conflictCheck:
        ctx.profile.matterDefaults.conflictCheck === 'clear_unless_lead' && !lead
          ? { status: 'clear', reason: CONFLICT_REASON }
          : { status: 'pending' },
      privileged: false,
      priority: priorityOf(ctx, data['priority'], path),
      ...(externalRef ? { externalRef } : {}),
      labels: [...labels].sort(),
      relatedMatterIds: [],
      ...(closed ? { closedAt: updatedAt } : {}),
      ...(archived ? { archivedAt: updatedAt } : {}),
      search: matterSearchTokens({
        number: deps.number,
        title,
        clientNames: [clientName],
        ...(externalRef ? { externalRef } : {}),
      }),
      openTaskCount: 0,
      wipCents: 0,
      recomputeVersion: 0,
      ...(legacyBilling ? { legacyBilling } : {}),
      ...(fee.legacy ? { legacy: fee.legacy } : {}),
      deletedAt: null,
      ...migratedMeta(ctx, { legacyPath: path, createdAt, updatedAt, by: ctx.uid, needsReview: review }),
    },
  };
  return { matter, records, links: linkedCardKeys({ path, data }) };
}

/**
 * The client a card's matter gets (D-10): named from the title's first part ("Jane Smith - will"
 * → Jane Smith; "Estate of …" is an organisation), or one "Client (imported)" placeholder per
 * matter. Either way the matter is flagged so the user can merge or rename it.
 */
function clientContact(
  ctx: TransformContext,
  cardPath: string,
  title: string,
  createdAt: Date,
  updatedAt: Date,
): TransformedRecord {
  const base = { legacyPath: `${cardPath}#client`, createdAt, updatedAt };
  const name = title === UNTITLED_MATTER ? '' : (title.split(/\s+[-–—:|]\s+/)[0] ?? '').trim();
  if (ctx.profile.matterDefaults.clientContact === 'placeholder' || !name) {
    return buildContact(ctx, { ...base, kind: 'organisation', orgName: 'Client (imported)' });
  }
  if (/^estate of\b/i.test(name)) return buildContact(ctx, { ...base, kind: 'organisation', orgName: name });
  return buildContact(ctx, { ...base, kind: 'person', ...splitName(name) });
}
