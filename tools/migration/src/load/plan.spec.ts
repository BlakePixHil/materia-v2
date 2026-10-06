import { PHASES } from './entities.ts';
import { planLine } from './plan.ts';

/** The load's plan keeps the person's migration review across re-runs and deltas (MIG-08, D-22). */

const MATTERS = PHASES.find((phase) => phase.file === 'matters');
const LOADED = new Date('2026-10-06T21:00:00.000Z');
const NOW = new Date('2026-10-07T21:00:00.000Z');
const PATH = 'orgs/o1/matters/m1';
const migration = { runId: 'run-1', legacyPath: 'workflows/w/cards/c1', loadedAt: LOADED };

const line = (data: Record<string, unknown>) => ({
  path: PATH,
  legacyPath: migration.legacyPath,
  data: { title: 'Estate of Fictional Wren', updatedAt: LOADED, updatedBy: 'u1', migration, ...data },
});
const existing = (data: Record<string, unknown>) => ({ ...line(data).data });

describe('planLine and the migration review', () => {
  if (!MATTERS) throw new Error('no matters phase');

  it('finds a record unchanged when the person reviewed the codes the run brings again', () => {
    const planned = planLine(
      MATTERS,
      line({ needsReview: ['client_from_title', 'swimlane_unknown'] }),
      existing({ reviewed: ['client_from_title', 'swimlane_unknown'] }),
      NOW,
    );
    expect(planned.decision).toBe('unchanged');
  });

  it('opens only codes the person hasn’t reviewed, and keeps what they did', () => {
    const planned = planLine(
      MATTERS,
      line({ title: 'Untitled matter (imported)', needsReview: ['title_missing', 'client_from_title'] }),
      existing({ needsReview: ['MIG_W_DOCUMENT_UNREADABLE'], reviewed: ['client_from_title'] }),
      NOW,
    );
    expect(planned.decision).toBe('update');
    expect(planned.op).toMatchObject({
      data: { needsReview: ['title_missing', 'MIG_W_DOCUMENT_UNREADABLE'], reviewed: ['client_from_title'] },
    });
  });

  it('leaves review state alone on records nobody reviewed', () => {
    const planned = planLine(MATTERS, line({ needsReview: ['title_missing'] }), existing({}), NOW);
    expect(planned).toMatchObject({ decision: 'update', changed: ['needsReview'] });
    expect(planned.op).toMatchObject({ data: { needsReview: ['title_missing'] } });
  });
});
