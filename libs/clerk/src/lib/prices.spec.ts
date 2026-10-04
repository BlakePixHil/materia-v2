import { CLERK_MODEL } from './model';
import { costMicros, totalTokens, ZERO_USAGE } from './prices';

describe('Clerk prices', () => {
  it('costs Opus 5.5 at $4 / $20 / $0.20 cache read / $5 cache write per million tokens', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    expect(costMicros(CLERK_MODEL, usage)).toEqual({ micros: 29_200_000, estimated: false });
    // 1,234 input + 567 output tokens: 4,936 + 11,340 micro-dollars.
    expect(costMicros(CLERK_MODEL, { ...ZERO_USAGE, inputTokens: 1234, outputTokens: 567 }).micros).toBe(16_276);
    expect(costMicros(CLERK_MODEL, { ...ZERO_USAGE, cacheReadTokens: 3 }).micros).toBe(1);
  });

  it('flags a model without a confirmed price as estimated', () => {
    expect(costMicros('claude-sonnet-5-5', { ...ZERO_USAGE, inputTokens: 10 })).toEqual({
      micros: 40,
      estimated: true,
    });
  });

  it('counts every token kind toward the budget', () => {
    expect(totalTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBe(10);
  });
});
