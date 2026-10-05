import * as D from '@materia/domain';

import { LOAD_QUERIES, loadDocs, parseLoadArgs, percentile } from './search-load.ts';
import { unwrap } from './seed/interop.ts';

const domain = unwrap(D);

/** The ⌘K load test's pure parts (CORE-15); the timed run needs the emulator. */
describe('search-load', () => {
  it('parses its options, 500 matters and a 300 ms p95 by default', () => {
    expect(parseLoadArgs([])).toEqual({ matters: 500, runs: 40, role: 'lawyer', budget: 300 });
    expect(parseLoadArgs(['--matters', '200', '--role', 'paralegal'])).toMatchObject({
      matters: 200,
      role: 'paralegal',
    });
    expect(() => parseLoadArgs(['--role', 'owner'])).toThrow(/role/);
    expect(() => parseLoadArgs(['--runs', '0'])).toThrow(/runs/);
  });

  it('takes nearest-rank percentiles', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([], 95)).toBe(0);
  });

  it('writes schema-valid, searchable matters, and every typed query finds some', () => {
    const docs = loadDocs(300, new Date('2026-10-05T00:00:00Z'));
    const matters = docs.filter((d) => /\/matters\/[^/]+$/.test(d.path));
    expect(matters).toHaveLength(300);
    for (const matter of matters.slice(0, 20)) {
      expect(domain.Matter.schema.safeParse(matter.data).success).toBe(true);
    }
    for (const typed of LOAD_QUERIES) {
      const token = domain.parseSearchQuery(typed).token as string;
      const found = docs.some((d) => Array.isArray(d.data['search']) && (d.data['search'] as string[]).includes(token));
      expect(found, typed).toBe(true);
    }
  });
});
