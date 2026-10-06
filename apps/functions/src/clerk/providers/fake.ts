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
 * `[fake:refuse]` refuses, and `[fake:propose]` makes the proposals step suggest a task.
 */
function chatStep(request: ClerkModelRequest): FakeStep | undefined {
  const last = request.messages[request.messages.length - 1];
  const asked = request.messages
    .filter((turn) => turn.role === 'user')
    .map(turnText)
    .join('\n');
  if (request.output?.name === 'chatProposals') {
    const proposals = asked.includes('[fake:propose]')
      ? [
          {
            kind: 'task',
            payload: { title: 'Request certified copies of the death certificate', priority: 'medium' },
            rationale: 'The answer says certified copies are still needed (fictional).',
            citations: [],
          },
        ]
      : [];
    return { chunks: [JSON.stringify({ proposals })] };
  }
  if (!request.tools?.length) return undefined;
  const toolResults = ((last?.content ?? []) as { type?: string }[]).some((block) => block.type === 'tool_result');
  if (toolResults) return { chunks: ['Fake Clerk reply ', 'after checking the matter.'] };
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
  if (question.includes('[fake:slow]'))
    return { chunks: Array.from({ length: 80 }, (_, i) => `word${i + 1} `), delayMs: 100 };
  return undefined;
}

function defaultStep(request: ClerkModelRequest): FakeStep {
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
