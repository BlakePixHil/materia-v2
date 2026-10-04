import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { RuleSetSchema } from './model';

/**
 * Published rule-set versions are immutable (ADR-009): a published file whose content changes fails
 * CI. Change a rule by adding a new version (vic-v2.json), never by editing a published one.
 * The hash is over canonical JSON (sorted keys), so formatting changes don't count.
 */
const DIR = path.resolve(import.meta.dirname, '../../data/rulesets');
const LOCK = path.join(DIR, 'published.lock.json');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function rulesetHash(json: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(json)))
    .digest('hex');
}

describe('rule-set files', () => {
  const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as Record<string, string>;
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'published.lock.json');

  it.each(files)('%s is valid and named after its id and version', (file) => {
    const json = JSON.parse(readFileSync(path.join(DIR, file), 'utf8'));
    const set = RuleSetSchema.parse(json);
    expect(file).toBe(`${set.ruleSetId}-v${set.version}.json`);
  });

  it('every published version matches its locked hash', () => {
    for (const file of files) {
      const json = JSON.parse(readFileSync(path.join(DIR, file), 'utf8')) as { published: boolean };
      if (!json.published) continue;
      expect(lock[file], `${file} is published but not in published.lock.json`).toBeDefined();
      expect(rulesetHash(json), `${file} changed after publication: add a new version instead`).toBe(lock[file]);
    }
  });

  it('never drops a published version', () => {
    for (const file of Object.keys(lock)) expect(files, `${file} is locked but missing`).toContain(file);
  });

  it('hashes canonical JSON, ignoring key order and formatting', () => {
    expect(rulesetHash({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(rulesetHash({ a: [{ c: 3, d: 2 }], b: 1 }));
    expect(rulesetHash({ a: 1 })).not.toBe(rulesetHash({ a: 2 }));
  });
});
