import * as D from '@materia/domain';

import { SeedGuardError } from './seed/guard.ts';
import { unwrap } from './seed/interop.ts';
import { FULL_LOAD_MATTERS, largeAccounts, largeOrgDocs, planLargeOrg, prng, TARGET } from './seed/large.ts';
import { main, parseSeedLargeArgs, writeStream } from './seed-large.ts';
import { entityRegistry } from './seed.ts';

const domain = unwrap(D);
const NOW = new Date('2026-10-07T01:00:00Z');
const TODAY = domain.today('Australia/Melbourne', NOW);

/** The kind of a generated document, by its path. */
function kindOf(path: string): string {
  const parts = path.split('/');
  if (parts[0] === 'orgs' && parts.length === 6) return parts[4] as string;
  if (parts[0] === 'orgs' && parts.length === 4) return parts[2] as string;
  return parts.length % 2 ? 'unknown' : (parts.at(-2) as string);
}

describe('seed-large', () => {
  it('plans the ticket’s target firm at scale 1 and shrinks it in proportion', () => {
    const target = planLargeOrg(1);
    expect(target).toMatchObject({
      matters: TARGET.matters,
      documents: TARGET.documents,
      timeEntries: TARGET.timeEntries,
      fullLoadMatters: FULL_LOAD_MATTERS,
    });
    expect(target.accounts).toHaveLength(TARGET.members);
    expect(FULL_LOAD_MATTERS).toBe(357);

    const small = planLargeOrg(0.05);
    expect(small).toMatchObject({ matters: 500, documents: 25_000, timeEntries: 100_000, fullLoadMatters: 357 });
    // The firm is the full 50 at every scale: member lists are read whole.
    expect(small.accounts).toHaveLength(TARGET.members);
    expect(new Set(small.accounts.map((a) => a.role))).toEqual(
      new Set(['owner', 'admin', 'lawyer', 'paralegal', 'readonly']),
    );
    expect(largeAccounts().find((a) => a.uid === 'lg-lawyer-1')?.email).toBe('lawyer1@large.example');
    expect(() => planLargeOrg(0)).toThrow('--scale');
    expect(() => planLargeOrg(2)).toThrow('--scale');
  });

  it('writes schema-valid records, as many as planned, the same on every run', () => {
    const plan = planLargeOrg(0.002); // 20 matters, 1,000 documents, 4,000 time entries
    const docs = [...largeOrgDocs(plan, { now: NOW, today: TODAY })];
    const again = [...largeOrgDocs(plan, { now: NOW, today: TODAY })];
    expect(again).toEqual(docs);
    expect(new Set(docs.map((d) => d.path)).size).toBe(docs.length);

    const counts = new Map<string, number>();
    for (const { path } of docs) counts.set(kindOf(path), (counts.get(kindOf(path)) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toMatchObject({
      matters: plan.matters,
      documents: plan.documents,
      timeEntries: plan.timeEntries,
      deadlines: plan.deadlines,
      tasks: plan.tasks,
      parties: plan.parties,
      notes: plan.notes,
      contacts: plan.contacts,
      members: plan.accounts.length,
      matterNumbers: plan.matters,
    });

    const registry = entityRegistry();
    const problems: string[] = [];
    for (const { path, data } of docs) {
      const entity = registry.find((e) => e.pattern.test(path));
      if (!entity) {
        problems.push(`${path}: no schema`);
        continue;
      }
      // The generator writes Dates (Firestore stores them as Timestamps), as the schemas expect.
      const result = entity.schema.safeParse(data);
      if (!result.success)
        problems.push(`${path}: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', ')}`);
    }
    expect(problems).toEqual([]);
  });

  it('gives the first lawyer a fee earner’s full load and keeps the denormalised matter fields and copies true', () => {
    // 500 matters, with a tenth of their documents and time entries (which this test doesn't look at).
    const full = planLargeOrg(0.05);
    const plan = { ...full, documents: full.documents / 10, timeEntries: full.timeEntries / 10 };
    let mine = 0;
    const deadlines = new Map<string, { dueDate: string; status: string }[]>();
    const openTasks = new Map<string, number>();
    const matters: { id: string; data: Record<string, unknown> }[] = [];
    const copies: { matterId: string; kind: string; copy: unknown }[] = [];
    let overdue = 0;
    let upcoming = 0;
    for (const { path, data } of largeOrgDocs(plan, { now: NOW, today: TODAY })) {
      const parts = path.split('/');
      if (parts[2] === 'matters' && parts.length === 4) {
        matters.push({ id: parts[3] as string, data });
        if (data['responsibleUid'] === 'lg-lawyer-1') mine++;
      }
      if (parts[4] === 'deadlines') {
        const list = deadlines.get(parts[3] as string) ?? [];
        list.push({ dueDate: String(data['dueDate']), status: String(data['status']) });
        deadlines.set(parts[3] as string, list);
        if (data['status'] === 'upcoming') {
          upcoming++;
          if (String(data['dueDate']) < TODAY) overdue++;
        }
      }
      // Each deadline's and task's copy of its matter (SEC-07c, SEC-07e).
      if (parts[4] === 'deadlines' || parts[4] === 'tasks') {
        copies.push({ matterId: parts[3] as string, kind: parts[4], copy: data['matter'] });
      }
      if (parts[4] === 'tasks' && data['status'] !== 'done') {
        openTasks.set(parts[3] as string, (openTasks.get(parts[3] as string) ?? 0) + 1);
      }
      // Stop after the matters (the time entries are many).
      if (matters.length === plan.matters) break;
    }
    expect(mine).toBe(FULL_LOAD_MATTERS);
    expect(overdue / upcoming).toBeLessThan(0.03);
    for (const { id, data } of matters) {
      const soonest = (deadlines.get(id) ?? [])
        .filter((d) => d.status === 'upcoming')
        .map((d) => d.dueDate)
        .sort()[0];
      expect((data['nextDeadline'] as { dueDate?: string } | undefined)?.dueDate).toBe(soonest);
      expect(data['openTaskCount']).toBe(openTasks.get(id) ?? 0);
    }
    const byId = new Map(matters.map(({ id, data }) => [id, data]));
    for (const { matterId, kind, copy } of copies) {
      const matter = byId.get(matterId) ?? {};
      expect(copy).toEqual(kind === 'tasks' ? domain.taskMatterCopy(matter) : domain.deadlineMatterCopy(matter));
    }
    expect(copies.some(({ copy }) => (copy as { privileged?: boolean }).privileged === true)).toBe(true);
  });

  it('parses its options and refuses anything but the emulators', async () => {
    expect(parseSeedLargeArgs([])).toEqual({ scale: 0.05, keep: false, dryRun: false, concurrency: 4 });
    expect(parseSeedLargeArgs(['--scale', '1', '--keep', '--concurrency', '8'])).toMatchObject({
      scale: 1,
      keep: true,
      concurrency: 8,
    });
    expect(() => parseSeedLargeArgs(['--scale', 'lots'])).toThrow('--scale');
    expect(() => parseSeedLargeArgs(['--concurrency', '0'])).toThrow('--concurrency');

    const env = { ...process.env };
    delete process.env['FIRESTORE_EMULATOR_HOST'];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(main(['--scale', '0.01'])).rejects.toBeInstanceOf(SeedGuardError);
      // A dry run only prints the plan, so it needs no emulator.
      await expect(main(['--scale', '1', '--dry-run'])).resolves.toBeUndefined();
      expect(log.mock.calls.flat().join('\n')).toContain('10,000');
    } finally {
      process.env = env;
      log.mockRestore();
    }
  });

  it('streams documents in batches, a few commits at a time', async () => {
    const committed: number[] = [];
    let inFlight = 0;
    let most = 0;
    const db = {
      doc: (path: string) => path,
      batch: () => {
        let size = 0;
        return {
          set: () => void size++,
          commit: async () => {
            inFlight++;
            most = Math.max(most, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 1));
            committed.push(size);
            inFlight--;
          },
        };
      },
    };
    const docs = Array.from({ length: 1234 }, (_, i) => ({ path: `x/${i}`, data: {} }));
    const progress: number[] = [];
    const written = await writeStream(db as never, docs, { concurrency: 2, onProgress: (n) => progress.push(n) });
    expect(written).toBe(1234);
    expect(committed.sort((a, b) => a - b)).toEqual([234, 500, 500]);
    expect(most).toBeLessThanOrEqual(2);
    expect(progress.at(-1)).toBe(1234);
  });

  it('draws the same numbers from the same seed', () => {
    const a = prng(1);
    const b = prng(1);
    const draws = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(draws);
    expect(draws.every((n) => n >= 0 && n < 1)).toBe(true);
  });
});
