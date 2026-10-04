import { cleanUpOverlays, DRAFTS, openIntake, probateState, resumeAt, warmUp } from './testing';

/** New matter intake (CORE-05): Enter moves on, Esc asks before closing, and the prefill button. */

beforeAll(warmUp);
afterEach(() => cleanUpOverlays());

describe('keyboard', () => {
  it('Enter in a field goes to the next step, and is blocked on an invalid step', async () => {
    const page = await resumeAt(probateState({ reached: 2 }), 'details');
    await page.press('Enter', page.field('Domicile') ?? undefined);
    expect(page.step()).toContain('Parties');
    await page.click('Back');
    await page.fill('Domicile', '');
    await page.press('Enter', page.field('Domicile') ?? undefined);
    expect(page.step()).toContain('Details');
    expect(page.errors()).toContain('Enter the domicile');
  });

  it('Enter in a multi-line field, on a button or in a contact search does not move on', async () => {
    const page = await resumeAt(probateState(), 'fees');
    await page.choose('Conditional');
    await page.press('Enter', page.field('Condition') ?? undefined);
    await page.press('Enter', page.buttons('Back')[0]);
    expect(page.step()).toContain('Fees');
    await page.click('Back');
    await page.click('Back');
    await page.click('Back');
    expect(page.step()).toContain('Clients');
    await page.press('Enter', page.page()?.querySelector('mt-intake-contact-picker input') ?? undefined);
    expect(page.step()).toContain('Clients');
  });

  it('Esc asks before closing; closing keeps the draft', async () => {
    const page = await openIntake();
    await page.choose('Will');
    await page.stable(20);
    await page.press('Escape');
    expect(page.text(page.dialog())).toContain('Close the new matter?');
    await page.click('Keep going', page.dialog() ?? undefined);
    await page.stable(20);
    expect(page.router.url).toBe('/matters/new');
    await page.press('Escape', document.body);
    await page.click('Close new matter', page.dialog() ?? undefined);
    await page.stable(20);
    expect(page.router.url).toBe('/matters');
    const saved = page.firestore.writes.filter((w) => w.path.startsWith(`${DRAFTS}/`));
    expect(saved.length).toBeGreaterThan(0);
    expect(page.firestore.get(saved[0]?.path ?? '')).toBeDefined();
  });

  it('lists Esc in the shortcuts sheet', async () => {
    const page = await openIntake();
    await page.press('?', document.body);
    expect(page.text(page.dialog())).toContain('Close the new matter');
  });
});

describe('prefill from email or notes', () => {
  it('is disabled while clerk.features.intakePrefill is off', async () => {
    const page = await openIntake();
    const button = page.buttons('Prefill from email or notes')[0] as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('is enabled when the flag is on', async () => {
    const page = await openIntake({ flags: { 'clerk.features.intakePrefill': true } });
    const button = page.buttons('Prefill from email or notes')[0] as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
