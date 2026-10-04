import type { ConflictHit } from '@materia/domain';

import { cleanUpOverlays, DRAFTS, PARALEGAL, probateState, resumeAt, warmUp } from './testing';

/** New matter intake (CORE-05): the conflict check step. Fictional data only. */

beforeAll(warmUp);
afterEach(() => cleanUpOverlays());

const ADVERSE: ConflictHit[] = [
  {
    subject: 0,
    contactId: 'c-old-quill',
    displayName: 'Avery J. Quill',
    score: 0.93,
    reasons: ['name', 'dateOfBirth'],
    matters: [
      {
        matterId: 'm-x',
        number: 'M-2025-0001',
        title: 'Estate of Fictional Fern',
        status: 'open',
        type: 'fp',
        role: 'defendant',
        adverse: 'Client against a defendant',
      },
    ],
  },
];

describe('conflict step', () => {
  it('runs by itself on the clients, the deceased and the parties, and not again when nothing changed', async () => {
    const page = await resumeAt(probateState(), 'fees');
    await page.click('Next');
    expect(page.step()).toContain('Conflict check');
    const runs = page.calls('conflicts-run');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.['subjects']).toEqual([
      expect.objectContaining({ name: 'Avery Quill', role: 'client', contactId: 'c-avery', dob: '1980-05-01' }),
      expect.objectContaining({ name: 'Margaret Whitfield', role: 'deceased', contactId: 'c-margaret' }),
      expect.objectContaining({ name: 'Avery Quill', role: 'executor', contactId: 'c-avery' }),
    ]);
    expect(page.text()).toContain('No matches');
    await page.click('Back');
    await page.click('Next');
    expect(page.calls('conflicts-run')).toHaveLength(1);
  });

  it('lets a lawyer record a conflict, which warns the matter can only be a lead and offers to discard', async () => {
    const page = await resumeAt(probateState({ reached: 5 }), 'conflict', { hits: ADVERSE });
    expect(page.text()).toContain('Avery J. Quill');
    expect(page.page()?.querySelector('[data-testid="conflict-lead-warning"]')).toBeNull();
    await page.choose('Conflict');
    expect(page.text(page.page()?.querySelector('[data-testid="conflict-lead-warning"]'))).toContain(
      'can only be created as a lead',
    );
    await page.click('Next');
    expect(page.errors()).toContain('Give a reason for a potential conflict or a conflict');
    await page.click('Discard intake');
    await page.click('Discard intake', page.dialog() ?? undefined);
    await page.stable(20);
    expect(page.router.url).toBe('/matters');
    expect(page.firestore.get(`${DRAFTS}/intake-d1`)).toBeUndefined();
  });

  it('leaves the determination to a lawyer for other roles: the matter is a lead', async () => {
    const page = await resumeAt(probateState({ reached: 5 }), 'conflict', { session: PARALEGAL });
    expect(page.text()).toContain('A lawyer must determine this check');
    expect(page.page()?.querySelector('mt-radio-group')).toBeNull();
    await page.click('Next');
    expect(page.step()).toContain('Review and create');
    expect(page.text()).toContain('the matter is created as a lead');
  });
});
