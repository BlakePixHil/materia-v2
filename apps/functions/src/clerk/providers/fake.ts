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

function defaultStep(request: ClerkModelRequest): FakeStep {
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
    return {
      model: step.model ?? request.model,
      stopReason: step.stopReason ?? 'end_turn',
      text,
      citations: step.citations ?? [],
      usage,
      content: [{ type: 'text', text }],
      serverFallback: step.serverFallback ?? false,
    };
  }
}
