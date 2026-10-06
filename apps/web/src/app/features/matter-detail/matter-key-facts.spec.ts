import { TestBed } from '@angular/core/testing';

import { DomainError } from '@materia/domain';
import { formatDateOnly } from '@materia/ui';

import {
  keyFactInput,
  keyFactText,
  matterErrorCopy,
  nextDeadlines,
  parseKeyFactInput,
  recentUpdateText,
  sortOpenTasks,
  statusChoices,
} from './matter-view';
import {
  cleanUpOverlays,
  deadlineServerCallables,
  MATTER,
  meta,
  openMatter,
  READONLY,
  recomputeSummary,
} from './testing';

/** Key facts on the Overview (CORE-06). Fictional data only. */

afterEach(cleanUpOverlays);

const facts = (page: Awaited<ReturnType<typeof openMatter>>) => {
  const list = page.body.querySelector('mt-key-facts dl');
  const terms = [...(list?.querySelectorAll('dt') ?? [])].map((dt) => page.text(dt));
  const values = [...(list?.querySelectorAll('dd .mt-facts-value') ?? [])].map((dd) => page.text(dd));
  return Object.fromEntries(terms.map((term, i) => [term, values[i]]));
};

describe('key facts', () => {
  it('shows the facts the matter’s type has', async () => {
    const page = await openMatter(undefined, {
      matter: { estate: { grantType: 'probate', grossValueCents: 125_000_000 } },
    });
    expect(facts(page)).toEqual({
      'Date of death': formatDateOnly('2026-07-22'),
      'Will date': '—',
      'Grant date': '—',
      'Grant number': '—',
      'Estate gross value': '$1,250,000.00',
    });
    TestBed.resetTestingModule();

    const will = await openMatter(undefined, { matter: { type: 'will', deceased: undefined } });
    expect(Object.keys(facts(will))).toEqual(['Will date']);
  });

  it('edits a fact inline, writing only that part of the matter', async () => {
    const page = await openMatter();
    await page.click('Edit Will date');
    await page.fill('Will date', '30/09/2019');
    await page.submit(page.body.querySelector('mt-key-facts'));
    expect(page.firestore.writes.at(-1)?.data).toMatchObject({ facts: { willDate: '2019-09-30' } });
    expect(page.firestore.get(MATTER)).toMatchObject({ labels: ['grant'], teamUids: ['user-priya'] });
    expect(facts(page)['Will date']).toBe(formatDateOnly('2019-09-30'));
    expect(page.body.querySelector('mt-key-facts form')).toBeNull();
  });

  it('records the grant date as a matter event, which recomputes the deadlines (CORE-10)', async () => {
    const page = await openMatter(undefined, {
      callables: {
        'deadlines-upsertEvent': (data, fs) => {
          const result = deadlineServerCallables()['deadlines-upsertEvent']?.(data, fs) as Record<string, unknown>;
          return { ...result, recompute: recomputeSummary({ proposed: ['rule-a-v2'], created: ['rule-b'] }) };
        },
      },
    });
    await page.click('Edit Grant date');
    await page.fill('Grant date', '30/09/2026');
    await page.submit(page.body.querySelector('mt-key-facts'));
    await page.stable(20);
    expect(page.calls('deadlines-upsertEvent')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', kind: 'grant_issued', date: '2026-09-30' }),
    ]);
    // Not written directly: the callable sets the key fact with the event.
    expect(page.firestore.writes.some((w) => w.path === MATTER && w.op === 'update')).toBe(false);
    expect(page.firestore.get(MATTER)?.['estate']).toEqual({ grantType: 'probate', grantDate: '2026-09-30' });
    expect(facts(page)['Grant date']).toBe(formatDateOnly('2026-09-30'));
    const toast = page.body.querySelector('.mt-toaster');
    expect(page.text(toast)).toContain('Grant date saved');
    expect(page.text(toast)).toContain('1 deadline change needs review · 1 deadline added.');
    await page.click('Review', toast ?? page.body);
    expect(page.router.url).toBe('/matters/m-whitfield/deadlines');
  });

  it('edits the date of death’s event, and shows the server’s reason when it’s refused', async () => {
    const page = await openMatter(undefined, {
      configure: (fs) =>
        fs.set(`${MATTER}/events/ev-death`, {
          kind: 'date_of_death',
          date: '2026-07-22',
          time: '14:30',
          label: 'At the hospice',
          sourceDocumentId: 'doc-cert',
          meta: {},
          orgId: 'org-harbour-vine',
          matterId: 'm-whitfield',
          deletedAt: null,
          ...meta,
        }),
    });
    await page.click('Edit Date of death');
    await page.fill('Date of death', '21/07/2026');
    await page.submit(page.body.querySelector('mt-key-facts'));
    await page.stable(20);
    // The rest of the event stays as recorded (the server replaces it whole).
    expect(page.calls('deadlines-upsertEvent')).toEqual([
      expect.objectContaining({
        eventId: 'ev-death',
        kind: 'date_of_death',
        date: '2026-07-21',
        time: '14:30',
        label: 'At the hospice',
        sourceDocumentId: 'doc-cert',
      }),
    ]);
    expect(facts(page)['Date of death']).toBe(formatDateOnly('2026-07-21'));

    await page.click('Edit Date of death');
    await page.fill('Date of death', '01/01/2027');
    await page.submit(page.body.querySelector('mt-key-facts'));
    await page.stable(20);
    expect(page.text(page.body.querySelector('mt-key-facts form'))).toContain('A date of death can’t be after today.');
  });

  it('checks what was typed, and clears a fact left empty', async () => {
    const page = await openMatter(undefined, { matter: { estate: { grantType: 'probate', grossValueCents: 500_00 } } });
    await page.click('Edit Estate gross value');
    await page.fill('Estate gross value', 'lots');
    await page.submit(page.body.querySelector('mt-key-facts'));
    expect(page.text(page.body.querySelector('mt-key-facts'))).toContain('Enter an amount like 1,250,000.00.');
    await page.fill('Estate gross value', '');
    await page.submit(page.body.querySelector('mt-key-facts'));
    expect(page.firestore.get(MATTER)?.['estate']).toEqual({ grantType: 'probate' });
  });

  it('keeps the date of death until there is a deceased, with the reason in a tooltip', async () => {
    const page = await openMatter(undefined, { matter: { deceased: undefined } });
    const blocked = page.body.querySelector<HTMLElement>('mt-key-facts [role="img"]');
    expect(blocked?.getAttribute('aria-label')).toBe(
      'Add the deceased on the Parties tab before recording the date of death',
    );
    expect(page.buttons('Edit Date of death')).toHaveLength(0);
    blocked?.click();
    await page.stable();
    expect(page.body.querySelector('mt-key-facts form')).toBeNull();
  });

  it('edits the date of death once there is a deceased; Escape cancels', async () => {
    const page = await openMatter();
    await page.click('Edit Date of death');
    const input = page.body.querySelector<HTMLInputElement>('mt-key-facts form input');
    expect(input?.value).toBe('22/07/2026');
    expect(document.activeElement).toBe(input);
    await page.press('Escape', {}, input ?? page.body);
    expect(page.body.querySelector('mt-key-facts form')).toBeNull();
  });

  it('read-only members see the facts without Edit buttons', async () => {
    const page = await openMatter(undefined, { session: READONLY });
    expect(facts(page)['Date of death']).toBe(formatDateOnly('2026-07-22'));
    expect(page.body.querySelectorAll('mt-key-facts button[aria-label^="Edit"]')).toHaveLength(0);
  });
});

describe('matter view helpers', () => {
  it('formats and parses key facts', () => {
    expect(keyFactText('money', 12_345)).toBe('$123.45');
    expect(keyFactText('text', undefined)).toBe('');
    expect(keyFactInput('money', 12_345)).toBe('123.45');
    expect(keyFactInput('date', '2026-07-22')).toBe('22/07/2026');
    expect(parseKeyFactInput('money', '$1,250,000.5')).toEqual({ value: 125_000_050 });
    expect(parseKeyFactInput('date', '31/02/2026')).toHaveProperty('error');
    expect(parseKeyFactInput('text', ' VIC-123 ')).toEqual({ value: 'VIC-123' });
    expect(parseKeyFactInput('text', 'x'.repeat(61))).toHaveProperty('error');
  });

  it('says who updated the matter only when it was someone else, recently', () => {
    const name = () => 'Priya Shah';
    const at = new Date('2026-10-04T00:00:00Z');
    expect(recentUpdateText({ updatedAt: at, updatedBy: 'u-p' }, 'u-j', at.getTime() + 60_000, name)).toBe(
      'Updated by Priya Shah just now',
    );
    expect(recentUpdateText({ updatedAt: at, updatedBy: 'u-p' }, 'u-j', at.getTime() + 600_000, name)).toBeNull();
    expect(recentUpdateText({ updatedAt: at, updatedBy: 'u-j' }, 'u-j', at.getTime(), name)).toBeNull();
  });

  it('offers the allowed status moves, asking for reasons and holding a lead until the check allows it', () => {
    expect(statusChoices('open', true).map((c) => [c.to, c.label, c.needsReason])).toEqual([
      ['on_hold', 'Put on hold', false],
      ['closed', 'Close matter…', false],
    ]);
    expect(statusChoices('closed', true)[0]).toMatchObject({ to: 'open', label: 'Reopen…', needsReason: true });
    expect(statusChoices('archived', true)).toEqual([{ to: 'open', label: 'Reopen…', needsReason: true }]);
    expect(statusChoices('lead', false)[0]?.blocked).toBeTruthy();
    expect(statusChoices('lead', true)[0]?.blocked).toBeUndefined();
  });

  it('orders deadlines and tasks, and words refusals', () => {
    const deadline = (id: string, dueDate: string, override?: string) =>
      ({
        id,
        title: id,
        dueDate,
        critical: false,
        status: 'upcoming',
        ...(override ? { override: { dueDate: override } } : {}),
      }) as never;
    expect(nextDeadlines([deadline('a', '2026-10-09'), deadline('b', '2026-10-20', '2026-10-01')], 1)).toMatchObject([
      { id: 'b' },
    ]);
    const task = (id: string, order: number, dueDate?: string) =>
      ({ id, order, ...(dueDate ? { dueDate } : {}) }) as never;
    expect(
      sortOpenTasks([task('x', 1), task('y', 2, '2026-10-09'), task('z', 0)]).map((t: { id: string }) => t.id),
    ).toEqual(['y', 'z', 'x']);
    expect(matterErrorCopy(new DomainError('FAILED_PRECONDITION', 'x', { reason: 'matter_closed' }))).toBe(
      'Reopen the matter before changing its stage.',
    );
    expect(
      matterErrorCopy(
        new DomainError('INVALID_ARGUMENT', 'x', {
          fields: { role: ['This contact already has that role on the matter'] },
        }),
      ),
    ).toBe('This contact already has that role on the matter.');
  });
});
