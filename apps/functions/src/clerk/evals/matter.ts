import { fixturePages, type EvalCase } from '@materia/clerk/evals';
import { can } from '@materia/domain';

import type { ChatToolSource } from '../chat/tools';
import type {
  ChunkHit,
  ChunkSearchInput,
  ChunkSearchPort,
  DocumentPage,
  DocumentTextPort,
  Row,
} from '../context/ports';
import { MemoryContextSource, type MemoryMatter, type MemoryOrg } from '../context/testing';

/**
 * An eval case as the practice's data (AI-12), so chat cases run through production's
 * `buildContext` (AI-03) and chat tools (AI-06): the case's matter facts become a matter with
 * parties, events, deadlines and tasks; its notes and documents keep their privileged flags. What
 * the role may see is decided by that production code, never here.
 */

export const EVAL_MATTER = 'm-eval';
/** The practice's time zone: `today` in a case is a Melbourne date. */
export const EVAL_TIME_ZONE = 'Australia/Melbourne';

type Data = Record<string, unknown>;
type Facts = {
  matterNumber?: string;
  title?: string;
  type?: string;
  status?: string;
  deceased?: string;
  dateOfDeath?: string;
  executors?: string[];
  probate?: { applicationFiled?: string | null; granted?: string | null };
  upcomingDeadlines?: { title: string; due: string }[];
  openTasks?: string[];
};

/** Noon on the case's date in Melbourne, so "today" in the system prompt is the case's `today`. */
export function caseNow(evalCase: EvalCase): Date {
  return new Date(`${evalCase.today}T01:00:00Z`);
}

/** The case's org: one active member with the case's role, and one matter. */
export function evalOrg(evalCase: EvalCase, orgId: string, uid: string): Record<string, MemoryOrg> {
  const facts = evalCase.matter as Facts;
  const contacts: Record<string, string> = {};
  const contact = (id: string, name: string | undefined) => {
    if (name) contacts[id] = name;
    return name ? id : undefined;
  };
  const deceased = contact('c-deceased', facts.deceased);
  const parties: Record<string, Data> = {};
  (facts.executors ?? []).forEach((name, i) => {
    parties[`p-executor-${i + 1}`] = { contactId: contact(`c-executor-${i + 1}`, name), role: 'executor' };
  });
  const events: Record<string, Data> = {};
  if (facts.probate?.applicationFiled)
    events['e-probate-filed'] = {
      kind: 'probate_filed',
      date: facts.probate.applicationFiled,
      label: 'Probate application filed',
    };
  const deadlines: Record<string, Data> = {};
  (facts.upcomingDeadlines ?? []).forEach((deadline, i) => {
    deadlines[`dl-${i + 1}`] = { title: deadline.title, dueDate: deadline.due, status: 'upcoming' };
  });
  const tasks: Record<string, Data> = {};
  (facts.openTasks ?? []).forEach((title, i) => {
    tasks[`t-${i + 1}`] = { title, status: 'todo' };
  });
  const day = 24 * 60 * 60 * 1000;
  const notes: Record<string, Data> = {};
  // Listed newest first: the first note is the most recent.
  evalCase.notes.forEach((note, i) => {
    notes[`n-${i + 1}`] = {
      bodyMd: note.text,
      privileged: note.privileged,
      createdAt: new Date(caseNow(evalCase).getTime() - (i + 1) * day),
    };
  });
  const documents: Record<string, Data> = {};
  for (const doc of evalCase.documents)
    documents[doc.id] = {
      name: doc.title,
      orgId,
      matterId: EVAL_MATTER,
      version: doc.version,
      privileged: doc.privileged,
      scan: { status: 'clean' },
      ingest: { status: 'done' },
    };
  const matter: MemoryMatter = {
    data: {
      number: facts.matterNumber,
      title: facts.title,
      type: facts.type,
      status: facts.status,
      privileged: false,
      ...(deceased ? { deceased: { contactId: deceased, dateOfDeath: facts.dateOfDeath } } : {}),
      ...(facts.probate?.granted ? { estate: { grantDate: facts.probate.granted } } : {}),
    },
    parties,
    events,
    deadlines,
    tasks,
    notes,
    documents,
  };
  return {
    [orgId]: {
      timezone: EVAL_TIME_ZONE,
      members: { [uid]: { status: 'active', role: evalCase.role } },
      contacts,
      matters: { [EVAL_MATTER]: matter },
    },
  };
}

/**
 * What the person attached: every document they can open (the panel only offers those). Privileged
 * documents a role can't open stay on the matter, reachable only through retrieval and the tools,
 * where production filters them.
 */
export function evalAttachments(evalCase: EvalCase): string[] {
  const privileged = can(evalCase.role, 'privileged.view');
  return evalCase.documents.filter((doc) => !doc.privileged || privileged).map((doc) => doc.id);
}

/** Each case document's text by page, from its fixture (what ingestion would have stored). */
export function evalDocumentText(evalCase: EvalCase, root: string): DocumentTextPort {
  return {
    async pages({ documentId, version }): Promise<DocumentPage[]> {
      const doc = evalCase.documents.find((d) => d.id === documentId && d.version === version);
      if (!doc) return [];
      return fixturePages(root, doc.fixture).map((text, i) => ({ page: i + 1, text }));
    },
  };
}

const STOP = new Set(
  'the and for with that this from what who whom when where which are was were has have had did does any all about into than then them they their there these those you your our not but can will would should could been being also its his her she him'.split(
    ' ',
  ),
);
const terms = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOP.has(word)),
  );

/**
 * Retrieval for evals: each page of each case document is one chunk, ranked by the share of the
 * query's words it contains (a stand-in for AI-04's vector search, with the same privileged
 * pre-filter and `k`). Pages sharing no word with the query aren't returned.
 */
export function evalChunkSearch(evalCase: EvalCase, root: string): ChunkSearchPort {
  const pages = evalCase.documents.flatMap((doc) =>
    fixturePages(root, doc.fixture).map((text, i) => ({ doc, page: i + 1, text, words: terms(text) })),
  );
  return {
    async searchChunks(input: ChunkSearchInput): Promise<ChunkHit[]> {
      const query = [...terms(input.query)];
      if (!query.length) return [];
      const k = Math.min(50, Math.max(1, input.k ?? 8));
      return pages
        .filter((page) => input.allowPrivileged || !page.doc.privileged)
        .map((page) => ({ page, score: query.filter((word) => page.words.has(word)).length / query.length }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map(({ page, score }) => ({
          documentId: page.doc.id,
          version: page.doc.version,
          page: page.page,
          ordinal: 0,
          text: page.text,
          privileged: page.doc.privileged,
          distance: 1 - score,
        }));
    },
  };
}

/** The chat tools' deadline and task reads over the same in-memory matter (no time entries). */
export function evalToolRecords(source: MemoryContextSource, orgId: string): ChatToolSource {
  const matter = () => source.orgs[orgId]?.matters[EVAL_MATTER];
  const rows = (records: Record<string, Data> | undefined): Row[] =>
    Object.entries(records ?? {}).map(([id, data]) => ({ id, data }));
  return {
    async records(_org, _matter, collection, statuses) {
      const all = rows(collection === 'deadlines' ? matter()?.deadlines : matter()?.tasks);
      return statuses ? all.filter((row) => statuses.includes(row.data['status'] as string)) : all;
    },
    async timeEntries() {
      return [];
    },
  };
}
