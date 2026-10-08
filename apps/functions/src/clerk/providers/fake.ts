import { datesInText } from '@materia/domain';

import {
  ClerkModelError,
  type ClerkModelPort,
  type ClerkModelRequest,
  type ClerkModelResult,
  type ClerkStreamEvent,
} from '../../ports';

/** One scripted reply. Text chunks stream in order; `error` throws (after any chunks: a disconnect). */
export interface FakeStep {
  chunks?: string[];
  stopReason?: string;
  usage?: Partial<ClerkModelResult['usage']>;
  citations?: unknown[];
  /** The model that "served" it (defaults to the requested model). */
  model?: string;
  serverFallback?: boolean;
  error?: ClerkModelError;
  /** Real milliseconds between chunks, so stop requests can land mid-stream. */
  delayMs?: number;
  /** Tools the reply asks to call (AI-06); the stop reason defaults to `tool_use`. */
  toolUses?: { id?: string; name: string; input?: unknown }[];
  /** A thinking block before the text, as a real turn carries (replayed verbatim). */
  thinking?: string;
}

/** Replies for structured-output schemas when no script is given (the emulator default). */
const SAMPLE_OUTPUT: Record<string, unknown> = {
  hello: { greeting: 'Hello from the fake Clerk model.', promptRef: 'fake' },
  ocrPage: {
    text: 'Fictional scanned page read by the fake OCR model. I appoint Sam Sample as executor of this will.',
    lowConfidence: false,
    language: 'en',
  },
  documentClassification: {
    category: 'other',
    suggestedTitle: 'Fictional document (fake Clerk model)',
    parties: [],
    language: 'en',
  },
};

/** The file note `[fake:note]` drafts (fictional). */
export const FAKE_DRAFTED_NOTE = 'Called the executor about the house valuation (fictional).';

/** The text of a turn's text blocks (user turns only carry our own blocks). */
function turnText(turn: ClerkModelRequest['messages'][number] | undefined): string {
  return ((turn?.content ?? []) as { type?: string; text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

/**
 * The chat panel's script in the emulator (AI-06), steered by markers in the question so e2e tests
 * can drive every path with fictional text: `[fake:tools]` searches the documents and reads the
 * deadlines before answering, `[fake:slow]` streams slowly (stop, navigating away, two tabs),
 * `[fake:refuse]` refuses, `[fake:propose]` makes the proposals step suggest a task, and
 * `[fake:note]` drafts a file note with the drafting tool (AI-06b).
 */
function chatStep(request: ClerkModelRequest): FakeStep | undefined {
  const last = request.messages[request.messages.length - 1];
  const asked = request.messages
    .filter((turn) => turn.role === 'user')
    .map(turnText)
    .join('\n');
  if (request.output?.name === 'chatProposals') {
    const tasks = asked.includes('[fake:propose]')
      ? [
          {
            title: 'Request certified copies of the death certificate',
            details: '',
            dueDate: '',
            priority: 'medium',
            rationale: 'The answer says certified copies are still needed (fictional).',
            citations: [],
          },
        ]
      : [];
    return { chunks: [JSON.stringify({ tasks, deadlines: [], events: [], notes: [], keyFacts: [], letters: [] })] };
  }
  if (!request.tools?.length) return undefined;
  const toolResults = ((last?.content ?? []) as { type?: string }[]).some((block) => block.type === 'tool_result');
  if (toolResults) {
    const called = (request.messages.at(-2)?.content ?? []) as { type?: string; name?: string }[];
    return called.some((block) => block.type === 'tool_use' && block.name === 'draft_note')
      ? { chunks: ['I’ve drafted that file note. It is waiting below for you to confirm.'] }
      : { chunks: ['Fake Clerk reply ', 'after checking the matter.'] };
  }
  const question = turnText(last);
  if (question.includes('[fake:refuse]')) return { chunks: ['I can’t help with that request.'], stopReason: 'refusal' };
  if (question.includes('[fake:tools]'))
    return {
      chunks: ['Let me check the matter. '],
      toolUses: [
        { name: 'search_documents', input: { query: 'executor' } },
        { name: 'get_deadlines', input: {} },
      ],
    };
  if (question.includes('[fake:note]'))
    return { toolUses: [{ name: 'draft_note', input: { text: FAKE_DRAFTED_NOTE } }] };
  if (question.includes('[fake:slow]'))
    return { chunks: Array.from({ length: 80 }, (_, i) => `word${i + 1} `), delayMs: 100 };
  return undefined;
}

/** The letter the fake writes for Clerk drafting (AI-10): fictional, with one placeholder. */
export const FAKE_DRAFT_PARAGRAPHS = [
  'Dear Sir or Madam',
  'We act for the executor of the estate of the late person named in this matter (fictional letter from the fake Clerk model).',
  'Please let us know the balance of each account held in the deceased’s name as at [[TO CONFIRM: date of death]].',
  'Thank you for your help.',
] as const;

/** The passage the fake writes for a rewrite (AI-10). */
export const FAKE_REWRITE =
  'Please tell us the balance of each account as at the date of death (rewritten by the fake Clerk model).';

/**
 * Clerk drafting's script (AI-10): a short letter with one placeholder, slowly with `[fake:slow]`
 * in the instructions (stop, navigating away), or a refusal with `[fake:refuse]`; a rewrite
 * returns `FAKE_REWRITE`.
 */
function draftStep(request: ClerkModelRequest): FakeStep | undefined {
  if (request.system.includes('## Rewriting part of a letter')) return { chunks: [FAKE_REWRITE] };
  if (!request.system.includes('## Drafting a letter')) return undefined;
  const asked = turnText(request.messages[request.messages.length - 1]);
  if (asked.includes('[fake:refuse]')) return { chunks: ['I can’t draft that letter.'], stopReason: 'refusal' };
  const letter = FAKE_DRAFT_PARAGRAPHS.join('\n\n');
  if (asked.includes('[fake:slow]'))
    return {
      chunks: letter.split(/(?<= )/).concat(Array.from({ length: 60 }, (_, i) => ` more${i + 1}`)),
      delayMs: 100,
    };
  return { chunks: FAKE_DRAFT_PARAGRAPHS.map((paragraph, i) => (i ? `\n\n${paragraph}` : paragraph)) };
}

/**
 * An Insights narrative (INS-04) the number check accepts: one paragraph per figure (at most two)
 * that writes the current period's value as `<org_metrics>` gives it, citing it. With no figures,
 * it says there isn't enough to explain.
 */
export function narrativeStep(request: ClerkModelRequest): FakeStep {
  const text = request.messages.map(turnText).join('\n');
  const json = /<org_metrics>\n([\s\S]*?)\n<\/org_metrics>/.exec(text)?.[1];
  let metrics: { current?: { label?: string }; figures?: Record<string, string | null>[] } = {};
  try {
    metrics = json ? JSON.parse(json) : {};
  } catch {
    metrics = {};
  }
  const figures = (metrics.figures ?? []).filter((figure) => typeof figure['current'] === 'string').slice(0, 2);
  const paragraphs = figures.map((figure) => ({
    text: `${figure['label']}: ${figure['current']} in ${metrics.current?.label ?? 'this period'} (fake Clerk model).`,
    citations: [
      {
        metric: String(figure['metric']),
        period: 'current',
        ...(figure['dimension'] ? { dimension: String(figure['dimension']) } : {}),
      },
    ],
  }));
  const output = paragraphs.length
    ? { paragraphs, insufficientData: false }
    : {
        paragraphs: [{ text: 'There isn’t enough recorded yet to explain (fake Clerk model).', citations: [] }],
        insufficientData: true,
      };
  return { chunks: [JSON.stringify(output)] };
}

/**
 * A matter brief (AI-06c) the checks accept: an item for the first overdue and the first upcoming
 * deadline, the newest document added and the first open suggestion (or undated task), each
 * worded from the facts `<matter_facts kind="brief">` gives and citing its ref.
 */
export function matterBriefStep(request: ClerkModelRequest): FakeStep {
  const text = request.messages.map(turnText).join('\n');
  const json = /<matter_facts [^>]*kind="brief"[^>]*>\n([\s\S]*?)\n<\/matter_facts>/.exec(text)?.[1];
  type Row = {
    ref?: string;
    title?: string;
    due?: string;
    name?: string;
    type?: string;
    added?: string;
    text?: string;
  };
  let facts: Record<string, Row[] | undefined> = {};
  try {
    facts = json ? JSON.parse(json) : {};
  } catch {
    facts = {};
  }
  const first = (key: string) => facts[key]?.[0];
  const items: { kind: string; text: string; refs: string[] }[] = [];
  const overdue = first('overdueDeadlines');
  if (overdue?.ref)
    items.push({ kind: 'due', text: `${overdue.title} was due ${overdue.due} (fake Clerk).`, refs: [overdue.ref] });
  const upcoming = first('upcomingDeadlines');
  if (upcoming?.ref)
    items.push({ kind: 'due', text: `${upcoming.title} is due ${upcoming.due} (fake Clerk).`, refs: [upcoming.ref] });
  const doc = first('documentsAdded');
  if (doc?.ref)
    items.push({
      kind: 'changed',
      text: `${doc.name} (${doc.type}) was added ${doc.added} (fake Clerk).`,
      refs: [doc.ref],
    });
  const next = first('suggestions') ?? first('undatedTasks');
  if (next?.ref) items.push({ kind: 'next', text: `Next: ${next.text ?? next.title} (fake Clerk).`, refs: [next.ref] });
  const headline = items.length ? 'Here is where this matter stands (fake Clerk).' : 'Nothing needs you (fake Clerk).';
  return { chunks: [JSON.stringify({ headline, items })] };
}

/** Words that tell the fake model which key date a sentence states (fictional files only). */
const EVENT_WORDS: [kind: string, pattern: RegExp][] = [
  ['date_of_death', /\b(died|death|passed away)\b/i],
  ['grant_issued', /\bgrant(ed)?\b.*\b(probate|letters of administration)\b|\bprobate\b.*\bgranted\b/i],
  ['notice_published', /\bnotice of intention\b/i],
  ['probate_filed', /\bapplication\b.*\bfiled\b|\bfiled\b.*\bapplication\b/i],
  ['statutory_notice_published', /\bnotice to (creditors|claimants)\b/i],
  ['caveat_lodged', /\bcaveat\b.*\blodged\b/i],
];

/** Every block's text a request carries: our text blocks and the excerpts (`search_result`). */
function requestTexts(request: ClerkModelRequest): string[] {
  return request.messages.flatMap((turn) =>
    ((turn.content ?? []) as { type?: string; text?: string }[])
      .filter((block) => block.type === 'text' || block.type === 'search_result')
      .map((block) => block.text ?? ''),
  );
}

/**
 * Key dates (MIG-09, `events-from-file@1`): each sentence of a `<matter_note>` or an `<excerpt>`
 * that states a full date beside words for an estate step (`EVENT_WORDS`) becomes an event, cited
 * with that sentence verbatim. The first sentence for a kind wins.
 */
export function eventsStep(request: ClerkModelRequest): FakeStep {
  const sources: { source: 'note' | 'excerpt'; id: string; page?: number; text: string }[] = [];
  for (const text of requestTexts(request)) {
    for (const m of text.matchAll(/<matter_note id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/matter_note>/g))
      sources.push({ source: 'note', id: m[1] ?? '', text: m[2] ?? '' });
    for (const m of text.matchAll(/<excerpt document="([^"]+)" version="\d+" page="(\d+)">\n([\s\S]*?)\n<\/excerpt>/g))
      sources.push({ source: 'excerpt', id: m[1] ?? '', page: Number(m[2]), text: m[3] ?? '' });
  }
  const events = new Map<string, unknown>();
  for (const { text, ...cited } of sources) {
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const [date] = datesInText(sentence);
      const kind = EVENT_WORDS.find(([, pattern]) => pattern.test(sentence))?.[0];
      if (!date || !kind || events.has(kind)) continue;
      events.set(kind, {
        kind,
        date,
        rationale: 'The file states this date (fake Clerk model).',
        citations: [{ ...cited, quote: sentence.trim().slice(0, 300) }],
      });
    }
  }
  return { chunks: [JSON.stringify({ events: [...events.values()] })] };
}

function defaultStep(request: ClerkModelRequest): FakeStep {
  if (request.output?.name === 'insightsNarrative') return narrativeStep(request);
  if (request.output?.name === 'eventsFromFile') return eventsStep(request);
  if (request.output?.name === 'matterBrief') return matterBriefStep(request);
  const draft = draftStep(request);
  if (draft) return draft;
  const chat = chatStep(request);
  if (chat) return chat;
  const sample = request.output ? SAMPLE_OUTPUT[request.output.name] : undefined;
  return { chunks: sample ? [JSON.stringify(sample)] : ['Fake Clerk reply.'] };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every model the fake "account" can see. */
export const FAKE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-sonnet-5'] as const;

/**
 * Key validation in the emulator and tests (AI-02a), by markers in the key: `invalid` is rejected
 * (401), `unreachable` can't reach the API, `noopus` can't see Opus 5.5. Any other key is valid.
 */
export function fakeListModels(apiKey: string): string[] {
  if (apiKey.includes('invalid')) throw new ClerkModelError('auth', 'Provider rejected the credentials (401)', 401);
  if (apiKey.includes('unreachable')) throw new ClerkModelError('disconnected', 'Connection to the provider failed');
  return apiKey.includes('noopus') ? FAKE_MODELS.filter((model) => !model.startsWith('claude-opus')) : [...FAKE_MODELS];
}

/**
 * The fake Claude model (AI-02): scripted streams, refusals, truncation, invalid output and
 * provider errors, for unit and integration tests and the emulator. It honours the abort signal
 * like the real adapter (a stopped stream ends with `aborted`).
 */
export class FakeClerkModel implements ClerkModelPort {
  readonly requests: ClerkModelRequest[] = [];
  private readonly script: FakeStep[];

  constructor(
    script: FakeStep[] = [],
    private readonly fallback: (request: ClerkModelRequest) => FakeStep = defaultStep,
  ) {
    this.script = [...script];
  }

  /** Queue more replies. */
  push(...steps: FakeStep[]): void {
    this.script.push(...steps);
  }

  async listModels(apiKey: string): Promise<string[]> {
    return fakeListModels(apiKey);
  }

  async run(request: ClerkModelRequest, onEvent?: (event: ClerkStreamEvent) => void): Promise<ClerkModelResult> {
    this.requests.push(request);
    const step = this.script.shift() ?? this.fallback(request);
    let text = '';
    for (const chunk of step.chunks ?? []) {
      if (step.delayMs) await sleep(step.delayMs);
      if (request.signal?.aborted) throw new ClerkModelError('aborted', 'Stopped');
      text += chunk;
      onEvent?.({ type: 'text', text: chunk });
    }
    if (step.error) throw step.error;
    const usage = {
      inputTokens: 100,
      outputTokens: Math.max(1, Math.ceil(text.length / 4)),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ...step.usage,
    };
    const toolUses = (step.toolUses ?? []).map((use, i) => ({
      id: use.id ?? `fake-tool-${this.requests.length}-${i + 1}`,
      name: use.name,
      input: use.input ?? {},
    }));
    return {
      model: step.model ?? request.model,
      stopReason: step.stopReason ?? (toolUses.length ? 'tool_use' : 'end_turn'),
      text,
      citations: step.citations ?? [],
      usage,
      content: [
        ...(step.thinking ? [{ type: 'thinking', thinking: step.thinking, signature: 'fake-signature' }] : []),
        ...(text || !toolUses.length ? [{ type: 'text', text }] : []),
        ...toolUses.map((use) => ({ type: 'tool_use', ...use })),
      ],
      serverFallback: step.serverFallback ?? false,
      ...(toolUses.length ? { toolUses } : {}),
    };
  }
}
