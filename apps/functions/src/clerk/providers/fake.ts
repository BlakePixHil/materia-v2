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
};

function defaultStep(request: ClerkModelRequest): FakeStep {
  const sample = request.output ? SAMPLE_OUTPUT[request.output.name] : undefined;
  return { chunks: sample ? [JSON.stringify(sample)] : ['Fake Clerk reply.'] };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
