import { decodeIntakeDraftState } from '@materia/domain';

import { cleanUpOverlays, draftDoc, DRAFTS, openIntake, probateState, warmUp } from './testing';

/** New matter intake (CORE-05): drafts saved as you go, offered on the next visit. Fictional data only. */

beforeAll(warmUp);
afterEach(() => cleanUpOverlays());

const savedDrafts = (page: Awaited<ReturnType<typeof openIntake>>) =>
  page.firestore.writes.filter((w) => w.path.startsWith(`${DRAFTS}/`));

describe('intake drafts', () => {
  it('saves a draft a moment after a change, then updates it as the steps go by', async () => {
    const page = await openIntake();
    expect(savedDrafts(page)).toHaveLength(0);
    await page.choose('Will');
    await page.stable(20);
    const [created] = savedDrafts(page);
    expect(created?.op).toBe('create');
    expect(created?.path).toMatch(new RegExp(`^${DRAFTS}/intake-[0-9a-f-]+$`));
    const stored = page.firestore.get(created?.path ?? '') as Record<string, unknown>;
    expect(stored).toMatchObject({ orgId: 'org-harbour-vine', kind: 'intake', step: 'type' });
    expect(decodeIntakeDraftState(String(stored['stateJson']))).toMatchObject({ type: 'will' });
    expect(page.text()).toContain('Draft saved');
    await page.click('Next');
    await page.stable(20);
    expect(savedDrafts(page).at(-1)).toMatchObject({ op: 'update', path: created?.path, data: { step: 'clients' } });
  });

  it('says "Saving draft…" while an edit waits on the debounce, not the last save', async () => {
    const page = await openIntake({ autosaveMs: 200 });
    await page.choose('Will');
    expect(savedDrafts(page)).toHaveLength(0);
    expect(page.text()).toContain('Saving draft…');
    await page.stable(250);
    expect(page.text()).toContain('Draft saved');
    await page.click('Next');
    expect(page.text()).toContain('Saving draft…');
    expect(page.text()).not.toContain('Draft saved');
    await page.stable(250);
    expect(savedDrafts(page).at(-1)).toMatchObject({ op: 'update', data: { step: 'clients' } });
    expect(page.text()).toContain('Draft saved');
  });

  it('offers the most recent draft and resumes it where it was', async () => {
    const page = await openIntake({
      configure: (fs) => {
        fs.set(`${DRAFTS}/intake-old`, draftDoc(probateState({ type: 'will' }), 'clients', new Date('2026-09-20')));
        fs.set(`${DRAFTS}/intake-new`, draftDoc(probateState(), 'fees', new Date('2026-10-03T22:00:00Z')));
        fs.set(`${DRAFTS}/intake-other-org`, {
          ...draftDoc(probateState(), 'review', new Date('2026-10-04')),
          orgId: 'org-elsewhere',
        });
      },
    });
    const offer = page.text(page.page()?.querySelector('[data-testid="intake-resume"]'));
    expect(offer).toContain('You started a probate matter, last saved today. It was at “Fees”.');
    await page.click('Resume draft');
    expect(page.step()).toContain('Fees');
    expect(page.field('Fixed fee')?.value).toBe('4,500');
    await page.fill('Fixed fee', '5,000');
    await page.stable(20);
    expect(savedDrafts(page).at(-1)).toMatchObject({ op: 'update', path: `${DRAFTS}/intake-new` });
  });

  it('starting fresh deletes the offered draft', async () => {
    const page = await openIntake({
      configure: (fs) => fs.set(`${DRAFTS}/intake-new`, draftDoc(probateState(), 'fees')),
    });
    await page.click('Start fresh');
    expect(page.firestore.get(`${DRAFTS}/intake-new`)).toBeUndefined();
    expect(page.step()).toContain('Matter type');
    expect(page.page()?.querySelector('[aria-checked="true"]')).toBeNull();
  });

  it('keeps the draft when leaving mid-flow', async () => {
    const page = await openIntake();
    await page.choose('Probate');
    await page.router.navigateByUrl('/matters');
    await page.stable(20);
    const saved = savedDrafts(page);
    expect(saved).toHaveLength(1);
    expect(page.firestore.get(saved[0]?.path ?? '')).toMatchObject({ step: 'type' });
  });
});
