import type { Firestore } from 'firebase-admin/firestore';

import { EventsFromFileOutput } from '@materia/clerk';
import {
  isDateOnly,
  QUOTE_MATCH_THRESHOLD,
  quoteScore,
  quoteStatesDate,
  today,
  verifyQuote,
  type ContextManifest,
  type SuggestionProposal,
} from '@materia/domain';

import { EVENT_SUGGESTION_TTL_DAYS } from './shared';
import type { ContextBuilder } from '../clerk/context/build-context';
import type { DocumentTextPort } from '../clerk/context/ports';
import type { ClerkGateway, GatewayContext } from '../clerk/gateway';
import { isDeleted } from '../contacts/shared';
import type { Log } from '../core/log';
import { eventsPath } from '../deadlines/shared';
import { matterPath } from '../matters/shared';
import type { Clock } from '../ports';
import { proposeSuggestions } from '../suggestions/propose';
import { orgTimeZone } from '../templates/shared';

/**
 * Key dates from a migrated estate matter's file (MIG-09, D-21): Clerk (`events-from-file@1`,
 * medium effort) reads the matter's facts, recent notes and the document excerpts closest to the
 * estate's steps, and lists the dates they state. Each one becomes an `event` suggestion (AI-07)
 * only when one of its quotes is found in the note or on the page it cites and states that date;
 * accepting it records the event, which recomputes the matter's deadlines (CORE-10), past ones
 * marked `pastOnCreation`. Only gaps are filled: a kind the matter already records is left alone,
 * and so is a kind the file gives two dates for.
 */

export const EVENTS_PROMPT = 'events-from-file@1.0.0';

/** What retrieval looks for: the estate's steps, in the words files use for them. */
export const EVENTS_QUERY = [
  'date of death, died on, passed away',
  'will dated, last will found or located',
  'notice of intention to apply for a grant published',
  'application for probate or letters of administration filed',
  'grant of probate or letters of administration made or issued',
  'notice to creditors and claimants published',
  'caveat lodged',
  'grant served',
  'family provision claim filed',
].join('; ');

type Data = Record<string, unknown>;
type ProposedEvent = EventsFromFileOutput['events'][number];

export interface MatterEventsDeps {
  db: Firestore;
  gateway: Pick<ClerkGateway, 'run'>;
  context: ContextBuilder;
  text: DocumentTextPort;
  clock: Clock;
  log: Log;
}

export interface MatterEventsResult {
  /** Suggestions made. */
  created: number;
  /** Events Clerk listed that were dropped (no checked quote stating the date, already recorded, two dates). */
  dropped: number;
}

/** Reads one matter's file for its key dates and proposes them. Throws what the gateway throws. */
export async function extractMatterEvents(
  deps: MatterEventsDeps,
  ctx: GatewayContext,
  matterId: string,
): Promise<MatterEventsResult> {
  const { db } = deps;
  const context = await deps.context.buildContext({
    ctx,
    scope: { matterId },
    feature: 'eventsExtraction',
    query: EVENTS_QUERY,
  });
  const todayIso = today(await orgTimeZone(db, ctx.orgId), deps.clock.now());
  const result = await deps.gateway.run<EventsFromFileOutput>({
    ctx,
    feature: 'eventsExtraction',
    promptId: EVENTS_PROMPT,
    vars: { today: todayIso },
    context,
    output: EventsFromFileOutput,
  });
  const parsed = EventsFromFileOutput.safeParse(result.parsed);
  if (result.status !== 'done' || !parsed.success) {
    deps.log.info('migration key dates: no reply', { matterId, status: result.status });
    return { created: 0, dropped: 0 };
  }
  const manifest = result.manifest ?? context.manifest;
  const recorded = await recordedKinds(db, ctx.orgId, matterId);
  const proposals = await toProposals(deps, ctx.orgId, matterId, parsed.data.events, {
    manifest,
    recorded,
    today: todayIso,
  });
  if (!proposals.length) return { created: 0, dropped: parsed.data.events.length };
  const [promptId = 'events-from-file', promptVersion = '1.0.0'] = result.promptRef.split('@');
  const outcome = await proposeSuggestions(
    { db, orgId: ctx.orgId, clock: deps.clock, log: ctx.log },
    matterId,
    proposals,
    {
      privileged: result.privileged ?? manifest.privileged,
      promptId,
      promptVersion,
      model: result.model,
      ttlDays: EVENT_SUGGESTION_TTL_DAYS,
    },
  );
  return { created: outcome.created.length, dropped: parsed.data.events.length - outcome.created.length };
}

/** The kinds of the matter's live events. */
async function recordedKinds(db: Firestore, orgId: string, matterId: string): Promise<Set<string>> {
  const snap = await db.collection(eventsPath(orgId, matterId)).get();
  return new Set(snap.docs.filter((doc) => !isDeleted(doc.data())).map((doc) => String(doc.get('kind'))));
}

/**
 * The events worth proposing, with the citations that hold up: a note's quote must be in that note
 * (one the context showed), an excerpt's on its page of the version the context read; and the quote
 * must state the event's date. An event with none of those is dropped, as is a future date, a kind
 * already recorded, a kind listed twice, and a `custom` one without a label.
 */
export async function toProposals(
  deps: Pick<MatterEventsDeps, 'db' | 'text'>,
  orgId: string,
  matterId: string,
  events: readonly ProposedEvent[],
  input: { manifest: ContextManifest; recorded: ReadonlySet<string>; today: string },
): Promise<SuggestionProposal[]> {
  const notes = new Set(input.manifest.records.filter((r) => r.kind === 'note').map((r) => r.id));
  const versions = new Map<string, number>();
  for (const source of [...input.manifest.documents, ...input.manifest.chunks])
    versions.set(source.documentId, source.version);

  const kindCounts = new Map<string, number>();
  for (const event of events) kindCounts.set(event.kind, (kindCounts.get(event.kind) ?? 0) + 1);

  const noteText = new Map<string, string>();
  const pages = new Map<string, string[]>();
  const readNote = async (id: string) => {
    if (!noteText.has(id)) {
      const data = (await deps.db.doc(`${matterPath(orgId, matterId)}/notes/${id}`).get()).data() as Data | undefined;
      noteText.set(id, data && !isDeleted(data) ? String(data['bodyMd'] ?? '') : '');
    }
    return noteText.get(id) ?? '';
  };
  const readPages = async (documentId: string, version: number) => {
    const key = `${documentId}@${version}`;
    if (!pages.has(key)) {
      const read = await deps.text.pages({ orgId, matterId, documentId, version }).catch(() => []);
      const byPage: string[] = [];
      for (const { page, text } of read) byPage[page - 1] = text;
      pages.set(
        key,
        Array.from(byPage, (text) => text ?? ''),
      );
    }
    return pages.get(key) ?? [];
  };

  const proposals: SuggestionProposal[] = [];
  for (const event of events) {
    if (!isDateOnly(event.date) || event.date > input.today) continue;
    const label = event.label?.trim();
    if (event.kind === 'custom' ? !label : input.recorded.has(event.kind) || (kindCounts.get(event.kind) ?? 0) > 1)
      continue;
    const citations: NonNullable<SuggestionProposal['citations']> = [];
    for (const citation of event.citations) {
      const quote = citation.quote.trim();
      if (!quote || !quoteStatesDate(quote, event.date)) continue;
      if (citation.source === 'note') {
        if (!notes.has(citation.id)) continue;
        if (quoteScore(quote, await readNote(citation.id)) < QUOTE_MATCH_THRESHOLD) continue;
        citations.push({ kind: 'record', recordRef: { collection: 'notes', id: citation.id }, quote });
      } else {
        const version = versions.get(citation.id);
        if (version === undefined || citation.page === undefined) continue;
        if (!verifyQuote({ quote, page: citation.page }, await readPages(citation.id, version)).verified) continue;
        citations.push({ kind: 'document', documentId: citation.id, docVersion: version, page: citation.page, quote });
      }
    }
    if (!citations.length) continue;
    const source = citations.find((c) => c.kind === 'document')?.documentId;
    proposals.push({
      kind: 'event',
      payload: {
        kind: event.kind,
        date: event.date,
        ...(event.kind === 'custom' && label ? { label } : {}),
        ...(source ? { sourceDocumentId: source } : {}),
      },
      rationale: event.rationale,
      citations,
      dedupeKey: `event#migration#${event.kind}#${event.date}${event.kind === 'custom' ? `#${label?.toLowerCase()}` : ''}`,
    } as SuggestionProposal);
  }
  return proposals;
}
