import { TestBed } from '@angular/core/testing';

import { DomainError, STATUTORY_DISABLED_MESSAGE } from '@materia/domain';
import { formatDateOnly } from '@materia/ui';

import { deadlineErrorCopy, monthLabel, recomputeSummaryText, sameData, shiftMonth } from './deadline-view';
import { parseEventTime } from './event-dialog';
import { storedDocument } from '../documents/testing';
import {
  cleanUpOverlays,
  deadlineServerCallables,
  MATTER,
  ME,
  meta,
  openMatter,
  PARALEGAL,
  PRIYA,
} from '../matter-detail/testing';

/** The Deadlines screen and the matter's Deadlines tab (CORE-10). Fictional data only. */

afterEach(cleanUpOverlays);

type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;
type Fs = Page['firestore'];

const TAB = '/matters/m-whitfield/deadlines';
const RULES_ON = { 'deadlines.ruleset.vic.v1': true };

const computed = (ruleId: string, dueDate?: string) => ({
  ruleId,
  ruleSetId: 'vic',
  ruleSetVersion: 1,
  inputs: {},
  trace: [`anchor grant_issued = 2026-09-30`, `+ 6 months → ${dueDate ?? '?'}`],
  citation: 'Administration and Probate Act 1958 (Vic) s 99 (illustrative)',
  ...(dueDate ? { dueDate } : {}),
});

function deadlineDoc(title: string, data: Seed = {}): Seed {
  return {
    title,
    kind: 'statutory',
    critical: false,
    status: 'upcoming',
    assigneeUid: ME,
    reminders: [],
    pastOnCreation: false,
    orgId: 'org-harbour-vine',
    matterId: 'm-whitfield',
    deletedAt: null,
    ...meta,
    ...data,
  };
}

function changeDoc(data: Seed): Seed {
  return {
    orgId: 'org-harbour-vine',
    matterId: 'm-whitfield',
    kind: 'moved',
    cause: 'event',
    status: 'pending',
    earlier: true,
    intoPast: false,
    assigneeUid: ME,
    recomputeVersion: 2,
    critical: false,
    ...meta,
    ...data,
  };
}

/** Computed deadlines (one waiting on the grant), a review item, two proposals and an event. */
function seedDeadlines(fs: Fs): void {
  const d = (id: string, doc: Seed) => fs.set(`${MATTER}/deadlines/${id}`, doc);
  d(
    'rule-vic.fp.limitation',
    deadlineDoc('Family provision claim period ends', {
      critical: true,
      status: 'blocked',
      blockedReason: 'No grant yet',
      blockedCode: 'anchor_missing',
      computed: computed('vic.fp.limitation'),
    }),
  );
  d(
    'rule-vic.probate.advert_min',
    deadlineDoc('Earliest date to file for probate', {
      dueDate: '2026-10-20',
      critical: true,
      computed: computed('vic.probate.advert_min', '2026-10-20'),
      taskId: 't-cert',
    }),
  );
  d(
    'rule-org.executor_year',
    deadlineDoc('Executor’s year ends', {
      kind: 'internal',
      dueDate: '2027-07-22',
      computed: computed('org.executor_year', '2027-07-22'),
    }),
  );
  d(
    'd-past',
    deadlineDoc('Lodge the caveat response', {
      dueDate: '2026-09-01',
      pastOnCreation: true,
      computed: computed('vic.caveat.expiry', '2026-09-01'),
    }),
  );
  d('d-closed', deadlineDoc('Send costs disclosure', { kind: 'internal', dueDate: '2026-09-20', status: 'done' }));
  fs.set(
    `${MATTER}/deadlineChanges/rule-vic.probate.advert_min-v2`,
    changeDoc({
      deadlineId: 'rule-vic.probate.advert_min',
      ruleId: 'vic.probate.advert_min',
      title: 'Earliest date to file for probate',
      critical: true,
      fromDueDate: '2026-10-20',
      toDueDate: '2026-09-28',
      intoPast: true,
    }),
  );
  fs.set(
    `${MATTER}/deadlineChanges/rule-org.executor_year-v2`,
    changeDoc({
      deadlineId: 'rule-org.executor_year',
      ruleId: 'org.executor_year',
      title: 'Executor’s year ends',
      fromDueDate: '2027-07-22',
      toDueDate: '2027-07-21',
    }),
  );
  fs.set(`${MATTER}/events/ev-death`, {
    kind: 'date_of_death',
    date: '2026-07-22',
    meta: {},
    orgId: 'org-harbour-vine',
    matterId: 'm-whitfield',
    deletedAt: null,
    ...meta,
  });
}

const row = (page: Page, id: string) => page.body.querySelector<HTMLElement>(`mt-deadline-row[data-deadline="${id}"]`);
const change = (page: Page, id: string) => page.body.querySelector<HTMLElement>(`[data-change="${id}"]`);
const sectionTitles = (page: Page, heading: string) => {
  const section = [...page.body.querySelectorAll('section')].find((s) =>
    page.text(s.querySelector('h2, h3')).startsWith(heading),
  );
  return [...(section?.querySelectorAll('mt-deadline-row .title') ?? [])].map((t) => page.text(t));
};

describe('matter deadlines tab', () => {
  it('lists proposals, the review queue, open deadlines with traces, events and closed ones', async () => {
    const page = await openMatter(TAB, { configure: seedDeadlines, flags: RULES_ON });
    expect(page.text(page.body.querySelector('mt-matter-deadlines h2'))).toBe('Deadlines');
    // The red banner: a critical deadline would move into the past.
    const banner = page.body.querySelector('mt-pending-changes [role="alert"]');
    expect(page.text(banner)).toContain('A critical deadline would move into the past.');
    expect(page.text(change(page, 'rule-vic.probate.advert_min-v2'))).toContain(
      'Moves earlier: 2026-10-20 → 2026-09-28',
    );
    expect(page.text(change(page, 'rule-vic.probate.advert_min-v2'))).toContain('Accepting needs the matter number');
    expect(sectionTitles(page, 'Needs review')).toEqual(['Lodge the caveat response']);
    expect(sectionTitles(page, 'Open')).toEqual([
      'Advertise notice of intended application',
      'Earliest date to file for probate',
      'Executor’s year ends',
      'Family provision claim period ends',
    ]);
    // A waiting deadline has no date: it says why.
    expect(page.text(row(page, 'rule-vic.fp.limitation'))).toContain('Waiting: No grant yet');
    // The trace: in the chip's tooltip and behind "How it’s worked out".
    const filing = row(page, 'rule-vic.probate.advert_min') as HTMLElement;
    const trace = [...(filing.querySelectorAll('details p') ?? [])].map((p) => page.text(p));
    expect(trace.slice(0, 2)).toEqual([
      'Computed by rule vic.probate.advert_min (vic v1)',
      'Administration and Probate Act 1958 (Vic) s 99 (illustrative)',
    ]);
    expect(page.text(filing.querySelector('details ol'))).toContain('+ 6 months → 2026-10-20');
    expect(page.text(row(page, 'd-past'))).toContain('Already past when computed');
    expect(page.text(page.body.querySelector('[data-event="date_of_death"]'))).toContain('Date of death');
    expect(page.text(page.body.querySelector('details.closed summary'))).toBe('Closed (1)');
    expect(page.text(page.body)).not.toContain(STATUTORY_DISABLED_MESSAGE);
  });

  it('says statutory deadlines are off while the rule set awaits review', async () => {
    const page = await openMatter(TAB, { configure: seedDeadlines });
    await page.stable(10);
    expect(page.text(page.body.querySelector('mt-matter-deadlines mt-note'))).toBe(STATUTORY_DISABLED_MESSAGE);
  });

  it('accepts a critical change only with the matter number typed, and rejects another', async () => {
    const page = await openMatter(TAB, { configure: seedDeadlines, flags: RULES_ON });
    await page.click('Accept', change(page, 'rule-vic.probate.advert_min-v2') ?? page.body);
    const dialog = await page.openedDialog();
    expect(page.text(dialog)).toContain('Accept a change to a critical deadline?');
    expect(page.text(dialog)).toContain('The new date has already passed.');
    const accept = () => page.buttons('Accept change', dialog ?? page.body)[0] as HTMLButtonElement;
    expect(accept().disabled).toBe(true);
    await page.fill('Type M-2026-0142 to confirm', 'M-2026-0143', dialog ?? page.body);
    expect(accept().disabled).toBe(true);
    await page.fill('Type M-2026-0142 to confirm', ' m-2026-0142 ', dialog ?? page.body);
    expect(accept().disabled).toBe(false);
    accept().click();
    await page.stable(20);
    expect(page.calls('deadlines-resolveChange')).toEqual([
      expect.objectContaining({
        matterId: 'm-whitfield',
        changeId: 'rule-vic.probate.advert_min-v2',
        accept: true,
        confirmation: 'm-2026-0142',
      }),
    ]);
    expect(page.firestore.get(`${MATTER}/deadlines/rule-vic.probate.advert_min`)?.['dueDate']).toBe('2026-09-28');
    expect(change(page, 'rule-vic.probate.advert_min-v2')).toBeNull();
    expect(page.body.querySelector('mt-pending-changes [role="alert"]')).toBeNull();
    expect(page.text(page.body.querySelector('mt-matter-deadlines > [aria-live]'))).toContain(
      'Change accepted: Earliest date to file for probate.',
    );

    // A non-critical change is decided straight away.
    await page.click('Reject', change(page, 'rule-org.executor_year-v2') ?? page.body);
    await page.stable(20);
    expect(page.calls('deadlines-resolveChange').at(-1)).toMatchObject({
      changeId: 'rule-org.executor_year-v2',
      accept: false,
    });
    expect(page.body.querySelector('mt-pending-changes')).toBeNull();
  });

  it('overrides a computed date with a reason', async () => {
    const page = await openMatter(TAB, { configure: seedDeadlines, flags: RULES_ON });
    await page.click('More actions for Executor’s year ends');
    await page.click('Override date…');
    const dialog = await page.openedDialog();
    expect(page.text(dialog)).toContain('The rule keeps computing');
    await page.fill('New due date', '01/07/2027', dialog ?? page.body);
    await page.submit(dialog);
    expect(page.text(page.dialog())).toContain('Say why the date is overridden.');
    await page.fill('Reason', 'Agreed with the fictional executor', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    await page.stable(20);
    expect(page.calls('deadlines-override')).toEqual([
      expect.objectContaining({
        deadlineId: 'rule-org.executor_year',
        dueDate: '2027-07-01',
        reason: 'Agreed with the fictional executor',
      }),
    ]);
    const updated = row(page, 'rule-org.executor_year') as HTMLElement;
    expect(page.text(updated)).toContain('Overridden');
    expect(page.text(updated.querySelector('details'))).toContain(
      'Overridden to 2027-07-01: Agreed with the fictional executor',
    );
  });

  it('marks a deadline done, closing its linked task too, and waives another with a reason', async () => {
    const page = await openMatter(TAB, { configure: seedDeadlines, flags: RULES_ON });
    await page.click('Mark done', row(page, 'rule-vic.probate.advert_min') ?? page.body);
    const dialog = await page.openedDialog();
    expect(page.text(dialog)).toContain('Also mark its linked task done');
    await page.submit(dialog);
    await page.stable(20);
    expect(page.calls('deadlines-complete')).toEqual([
      expect.objectContaining({
        deadlineId: 'rule-vic.probate.advert_min',
        outcome: 'done',
        completedOn: '2026-10-04',
        completeLinkedTasks: true,
      }),
    ]);
    expect(page.firestore.get(`${MATTER}/tasks/t-cert`)?.['status']).toBe('done');
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('Deadline marked done, with 1 linked task');
    expect(page.text(page.body.querySelector('details.closed summary'))).toBe('Closed (2)');

    await page.click('More actions for Executor’s year ends');
    await page.click('Waive…');
    await page.openedDialog();
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('Say why it’s waived.');
    await page.fill('Why is it waived?', 'The fictional estate was wound up early', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    await page.stable(20);
    expect(page.calls('deadlines-complete').at(-1)).toMatchObject({
      deadlineId: 'rule-org.executor_year',
      outcome: 'waived',
      reason: 'The fictional estate was wound up early',
    });
  });

  it('acknowledges a critical deadline, which stops it escalating (CORE-11)', async () => {
    const page = await openMatter(TAB, { configure: seedDeadlines, flags: RULES_ON });
    await page.click('More actions for Earliest date to file for probate');
    await page.click('Acknowledge');
    await page.stable(20);
    expect(page.calls('deadlines-acknowledge')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', deadlineId: 'rule-vic.probate.advert_min' }),
    ]);
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('Deadline acknowledged');
    // Acknowledged: no longer offered.
    await page.click('More actions for Earliest date to file for probate');
    expect(page.buttons('Acknowledge')).toHaveLength(0);
  });

  it('confirms a deadline past on creation as missed', async () => {
    const page = await openMatter(TAB, { configure: seedDeadlines, flags: RULES_ON });
    await page.click('More actions for Lodge the caveat response');
    await page.click('Confirm missed…');
    await page.openedDialog();
    expect(page.dialog()?.getAttribute('role')).toBe('alertdialog');
    await page.submit(page.dialog());
    await page.stable(20);
    expect(page.calls('deadlines-complete')).toEqual([
      expect.objectContaining({ deadlineId: 'd-past', outcome: 'missed' }),
    ]);
  });

  it('adds a manual deadline, then edits and deletes it', async () => {
    const page = await openMatter(TAB, { configure: seedDeadlines, flags: RULES_ON });
    await page.click('Add deadline');
    const dialog = await page.openedDialog();
    await page.submit(dialog);
    expect(page.text(dialog)).toContain('Give the deadline a title.');
    await page.fill('Title', 'Settle the sale of the fictional house', dialog ?? page.body);
    await page.fill('Due date', '30/11/2026', dialog ?? page.body);
    await page.fill('By', '16:00', dialog ?? page.body);
    await page.fill('Kind', '0', dialog ?? page.body);
    await page.submit(dialog);
    await page.stable(20);
    const write = page.firestore.writes.find((w) => w.op === 'create' && w.path.startsWith(`${MATTER}/deadlines/`));
    expect(write && page.firestore.get(write.path)).toMatchObject({
      title: 'Settle the sale of the fictional house',
      dueDate: '2026-11-30',
      dueTime: '16:00',
      kind: 'contractual',
      critical: false,
      status: 'upcoming',
      assigneeUid: ME,
      orgId: 'org-harbour-vine',
      matterId: 'm-whitfield',
    });
    const id = String(write?.path.split('/').at(-1));
    expect(page.text(row(page, id))).toContain('By 16:00');

    await page.click('More actions for Settle the sale of the fictional house');
    await page.click('Edit…');
    await page.openedDialog();
    await page.fill('Title', 'Settle the fictional house sale', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/deadlines/${id}`)?.['title']).toBe('Settle the fictional house sale');

    await page.click('More actions for Settle the fictional house sale');
    await page.click('Delete…');
    await page.click('Delete deadline', page.dialog() ?? page.body);
    await page.stable(20);
    expect(page.firestore.get(`${MATTER}/deadlines/${id}`)?.['deletedAt']).toBeTruthy();
    expect(row(page, id)).toBeNull();
  });

  it('records, edits and deletes events through the callables', async () => {
    const page = await openMatter(TAB, { configure: seedDeadlines, flags: RULES_ON });
    await page.click('Record event');
    const dialog = await page.openedDialog();
    // A native select's values are the options' indexes: Grant issued is the fifth kind.
    await page.fill('Event', '4', dialog ?? page.body);
    await page.fill('Date', '30/09/2026', dialog ?? page.body);
    await page.submit(dialog);
    await page.stable(20);
    expect(page.calls('deadlines-upsertEvent')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', kind: 'grant_issued', date: '2026-09-30' }),
    ]);
    expect(page.text(page.body.querySelector('[data-event="grant_issued"]'))).toContain('Grant issued');

    await page.click('Edit Date of death');
    await page.openedDialog();
    await page.fill('Date', '01/01/2027', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('A date of death can’t be after today.');
    await page.fill('Date', '21/07/2026', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    await page.stable(20);
    expect(page.calls('deadlines-upsertEvent').at(-1)).toMatchObject({ eventId: 'ev-death', date: '2026-07-21' });

    await page.click('Delete Grant issued');
    expect(page.text(page.dialog())).toContain('Nothing is removed until a lawyer accepts.');
    await page.click('Delete event', page.dialog() ?? page.body);
    await page.stable(20);
    expect(page.calls('deadlines-deleteEvent')).toHaveLength(1);
    expect(page.body.querySelector('[data-event="grant_issued"]')).toBeNull();
  });

  it('shows events on a line with their deadlines, or to scale, and remembers the view', async () => {
    const page = await openMatter(TAB, {
      configure: (fs) => {
        seedDeadlines(fs);
        fs.set(
          `${MATTER}/deadlines/rule-org.executor_year`,
          deadlineDoc('Executor’s year ends', {
            kind: 'internal',
            dueDate: '2027-07-22',
            computed: { ...computed('org.executor_year', '2027-07-22'), anchorEventId: 'ev-death' },
          }),
        );
      },
      flags: RULES_ON,
    });
    const timeline = () => page.body.querySelector('mt-event-timeline') as HTMLElement;
    // Linked: the event lists the deadline computed from it; today and upcoming deadlines follow.
    const death = timeline().querySelector('[data-event="date_of_death"]');
    expect(page.text(death?.querySelector('[data-linked="rule-org.executor_year"]'))).toContain('Executor’s year ends');
    const rail = [...timeline().querySelectorAll('.rail > li')].map((li) => page.text(li.querySelector('.title')));
    expect(rail).toEqual([
      'Date of death',
      'Today',
      'Advertise notice of intended application',
      'Earliest date to file for probate',
      'Executor’s year ends',
    ]);
    expect(page.text(timeline().querySelector('[data-upcoming="rule-org.executor_year"]'))).toContain(
      'From Date of death',
    );

    await page.click('To scale');
    await page.stable(5);
    expect(timeline().querySelector('.axis[role="img"]')?.getAttribute('aria-label')).toContain('drawn to scale');
    expect(page.text(timeline().querySelector('.pin'))).toContain('Date of death');
    expect(page.text(timeline().querySelector('.flat [data-event="date_of_death"]'))).toContain('Date of death');
    expect(page.buttons('Edit Date of death', timeline())).toHaveLength(1);
    expect(localStorage.getItem('materia.matter.eventsView')).toBe('scale');
  });

  describe('an event’s time and source document (CORE-10)', () => {
    /** Two death certificates with the same name, a privileged memo and a removed document, newest first. */
    const seedDocuments = (fs: Fs) => {
      const doc = (id: string, name: string, day: string, extra: Seed = {}) =>
        fs.set(`${MATTER}/documents/${id}`, storedDocument(id, name, { createdAt: new Date(day), ...extra }));
      doc('doc-cert', 'Death certificate.pdf', '2026-09-03T00:00:00Z');
      doc('doc-memo', 'Advice memo.pdf', '2026-09-02T00:00:00Z', { privileged: true });
      doc('doc-cert-scan', 'Death certificate.pdf', '2026-09-01T00:00:00Z');
      doc('doc-gone', 'Old draft.pdf', '2026-08-30T00:00:00Z', { deletedAt: new Date('2026-09-05T00:00:00Z') });
    };
    const select = (page: Page, label: string) => {
      const host = [...(page.dialog()?.querySelectorAll('mt-select') ?? [])].find((field) =>
        field.querySelector('.mt-label')?.textContent?.trim().startsWith(label),
      );
      const found = host?.querySelector('select');
      if (!found) throw new Error(`No select "${label}"`);
      return found;
    };
    const options = (page: Page, label: string) => [...select(page, label).options].slice(1).map((o) => page.text(o));
    const chosen = (page: Page, label: string) => {
      const field = select(page, label);
      return page.text(field.options[field.selectedIndex]);
    };
    const choose = async (page: Page, label: string, text: string) => {
      const field = select(page, label);
      const option = [...field.options].find((o) => page.text(o) === text);
      if (!option) throw new Error(`No option "${text}"`);
      await page.fill(label, option.value, page.dialog() ?? page.body);
    };
    const linkedDeath = (data: Seed) => (fs: Fs) => {
      seedDeadlines(fs);
      seedDocuments(fs);
      fs.set(`${MATTER}/events/ev-death`, { ...(fs.get(`${MATTER}/events/ev-death`) as Seed), ...data });
    };
    const details = (page: Page, root = 'mt-event-timeline') =>
      page.body.querySelector(`${root} [data-event="date_of_death"] [data-event-details]`);

    it('records a time and a source from the matter’s live documents', async () => {
      const page = await openMatter(TAB, {
        configure: (fs) => {
          seedDeadlines(fs);
          seedDocuments(fs);
        },
        flags: RULES_ON,
        callables: {
          // The fake server keeps the time and source too, so the timeline can show them.
          'deadlines-upsertEvent': (data, fs) => {
            const result = deadlineServerCallables()['deadlines-upsertEvent']?.(data, fs) as { eventId: string };
            const path = `${MATTER}/events/${result.eventId}`;
            fs.set(path, { ...(fs.get(path) as Seed), time: data['time'], sourceDocumentId: data['sourceDocumentId'] });
            return result;
          },
        },
      });
      await page.click('Record event');
      const dialog = await page.openedDialog();
      // Newest first; a repeated name is numbered, and removed documents aren't offered.
      expect(options(page, 'Source document')).toEqual([
        'None',
        'Death certificate.pdf',
        'Advice memo.pdf',
        'Death certificate.pdf (2)',
      ]);
      expect(chosen(page, 'Source document')).toBe('None');
      await page.fill('Event', '4', dialog ?? page.body);
      await page.fill('Date', '30/09/2026', dialog ?? page.body);
      await page.fill('Time', '9.30am', dialog ?? page.body);
      await page.submit(dialog);
      expect(page.text(page.dialog())).toContain('Enter a time like 14:30.');
      expect(page.calls('deadlines-upsertEvent')).toHaveLength(0);

      await page.fill('Time', '9:30', dialog ?? page.body);
      await choose(page, 'Source document', 'Death certificate.pdf (2)');
      await page.submit(dialog);
      await page.stable(20);
      expect(page.calls('deadlines-upsertEvent')).toEqual([
        expect.objectContaining({
          kind: 'grant_issued',
          date: '2026-09-30',
          time: '09:30',
          sourceDocumentId: 'doc-cert-scan',
        }),
      ]);
      const grant = page.body.querySelector('[data-event="grant_issued"] [data-event-details]');
      expect(page.text(grant)).toBe('At 09:30 Source: Death certificate.pdf');
      expect(grant?.querySelector('a')?.getAttribute('href')).toBe('/matters/m-whitfield/documents/doc-cert-scan');
    });

    it('shows the time and source on both views, and clears them when emptied', async () => {
      const page = await openMatter(TAB, {
        configure: linkedDeath({ time: '14:30', sourceDocumentId: 'doc-cert' }),
        flags: RULES_ON,
      });
      expect(page.text(details(page))).toBe('At 14:30 Source: Death certificate.pdf');
      expect(details(page)?.querySelector('a')?.getAttribute('href')).toBe('/matters/m-whitfield/documents/doc-cert');
      await page.click('To scale');
      await page.stable(5);
      expect(page.text(details(page, 'mt-event-timeline .flat'))).toBe('At 14:30 Source: Death certificate.pdf');

      await page.click('Edit Date of death');
      const dialog = await page.openedDialog();
      expect((dialog?.querySelector('mt-text-field[name="time"] input') as HTMLInputElement | null)?.value).toBe(
        '14:30',
      );
      expect(chosen(page, 'Source document')).toBe('Death certificate.pdf');
      await page.fill('Time', '', dialog ?? page.body);
      await choose(page, 'Source document', 'None');
      await page.submit(dialog);
      await page.stable(20);
      const call = page.calls('deadlines-upsertEvent').at(-1);
      expect(call).toMatchObject({ eventId: 'ev-death', kind: 'date_of_death', date: '2026-07-22' });
      expect(call).not.toHaveProperty('time');
      expect(call).not.toHaveProperty('sourceDocumentId');
    });

    it('offers privileged documents only with privileged.view, and keeps a source the reader can’t see', async () => {
      const page = await openMatter(TAB, {
        configure: linkedDeath({ time: '14:30', sourceDocumentId: 'doc-memo' }),
        flags: RULES_ON,
        session: PARALEGAL,
      });
      // No link to a privileged document for a paralegal; the time still shows.
      expect(page.text(details(page))).toBe('At 14:30');
      expect(details(page)?.querySelector('a')).toBeNull();

      await page.click('Edit Date of death');
      await page.openedDialog();
      expect(options(page, 'Source document')).toEqual([
        'None',
        'Death certificate.pdf',
        'Death certificate.pdf (2)',
        'The document already linked',
      ]);
      expect(chosen(page, 'Source document')).toBe('The document already linked');
      await page.submit(page.dialog());
      await page.stable(20);
      expect(page.calls('deadlines-upsertEvent').at(-1)).toMatchObject({
        eventId: 'ev-death',
        time: '14:30',
        sourceDocumentId: 'doc-memo',
      });
    });

    it('reads a time as 24-hour HH:MM', () => {
      expect(parseEventTime('9:05')).toBe('09:05');
      expect(parseEventTime(' 14:30 ')).toBe('14:30');
      expect(parseEventTime('00:00')).toBe('00:00');
      expect(parseEventTime('24:00')).toBeNull();
      expect(parseEventTime('9.30am')).toBeNull();
      expect(parseEventTime('12:60')).toBeNull();
    });
  });

  it('shows paralegals Mark done but not the lawyer’s decisions', async () => {
    const page = await openMatter(TAB, { configure: seedDeadlines, flags: RULES_ON, session: PARALEGAL });
    expect(page.buttons('Accept', change(page, 'rule-org.executor_year-v2') ?? page.body)).toHaveLength(0);
    expect(page.buttons('Mark done', row(page, 'rule-org.executor_year') ?? page.body)).toHaveLength(1);
    expect(page.buttons('More actions for Executor’s year ends')).toHaveLength(0);
  });
});

describe('deadlines screen', () => {
  /** Deadlines in each group around 2026-10-04 (a Sunday), on the matter and a colleague's. */
  function seedScreen(fs: Fs): void {
    seedDeadlines(fs);
    const d = (id: string, doc: Seed) => fs.set(`${MATTER}/deadlines/${id}`, doc);
    d('d-overdue', deadlineDoc('Reply to the fictional bank', { kind: 'internal', dueDate: '2026-10-01' }));
    d('d-today', deadlineDoc('File the inventory', { kind: 'court', dueDate: '2026-10-04', assigneeUid: PRIYA }));
  }

  /** The groups and rows shown: filters hide the others rather than remove them (SEC-07c). */
  const groups = (page: Page) =>
    [...page.body.querySelectorAll<HTMLElement>('section[data-group]:not([data-empty])')].map(
      (section) =>
        `${section.dataset['group']}: ${[...section.querySelectorAll('li:not([data-filtered]) mt-deadline-row .title')]
          .map((t) => page.text(t))
          .join(', ')}`,
    );

  it('groups upcoming deadlines, with my pending changes and the review queue above', async () => {
    const page = await openMatter('/deadlines', { configure: seedScreen, flags: RULES_ON });
    await page.stable(20);
    expect(page.text(page.body.querySelector('h1'))).toBe('Deadlines');
    expect(groups(page)).toEqual([
      'overdue: Reply to the fictional bank',
      'this_week: File the inventory',
      'next_30_days: Advertise notice of intended application, Earliest date to file for probate',
      'later: Executor’s year ends',
    ]);
    expect(sectionTitles(page, 'Needs review')).toEqual(['Lodge the caveat response']);
    const pending = page.body.querySelector('mt-pending-changes');
    expect(page.text(pending)).toContain('M-2026-0142 · Estate of Margaret Whitfield');
    expect(page.body.querySelector('mt-pending-changes [role="alert"]')).not.toBeNull();
    // The matter is named on each row, linking to its Deadlines tab.
    const link = row(page, 'd-overdue')?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/matters/m-whitfield/deadlines');
  });

  it('filters by mine, critical, kind and jurisdiction', async () => {
    const page = await openMatter('/deadlines', { configure: seedScreen, flags: RULES_ON });
    await page.stable(20);
    const inventory = row(page, 'd-today');
    await page.click('Mine');
    expect(groups(page).join(' | ')).not.toContain('File the inventory');
    // Set aside, not redrawn: the row comes back as it was.
    const item = inventory?.closest('li');
    expect(item?.hasAttribute('data-filtered')).toBe(true);
    expect(item?.getAttribute('aria-hidden')).toBe('true');
    await page.click('Mine');
    expect(row(page, 'd-today')).toBe(inventory);
    expect(item?.hasAttribute('data-filtered')).toBe(false);
    expect(item?.hasAttribute('aria-hidden')).toBe(false);
    await page.click('Mine');
    await page.click('Mine');
    await page.click('Critical');
    expect(groups(page)).toEqual([
      'next_30_days: Advertise notice of intended application, Earliest date to file for probate',
    ]);
    await page.click('Clear filters');
    await page.click('Kind');
    await page.click('Court');
    expect(groups(page)).toEqual(['this_week: File the inventory']);
    await page.click('Clear filters');
    await page.click('Jurisdiction');
    await page.click('NSW');
    expect(page.text(page.body)).toContain('No deadlines match');
  });

  it('shows a month calendar, and remembers the view', async () => {
    const page = await openMatter('/deadlines', { configure: seedScreen, flags: RULES_ON });
    await page.stable(20);
    await page.click('Calendar');
    const calendar = page.body.querySelector('mt-deadline-calendar');
    expect(page.text(calendar?.querySelector('h3'))).toBe('October 2026');
    const today = calendar?.querySelector('td[aria-current="date"]');
    expect(today?.getAttribute('data-date')).toBe('2026-10-04');
    expect(page.text(today)).toContain('File the inventory');
    expect(page.text(calendar?.querySelector('td[data-date="2026-10-20"]'))).toContain(
      'Earliest date to file for probate',
    );
    expect(localStorage.getItem('materia.deadlines.view')).toBe('calendar');
    await page.click('Next month');
    expect(page.text(calendar?.querySelector('h3'))).toBe('November 2026');
    await page.click('This month');
    expect(page.text(calendar?.querySelector('h3'))).toBe('October 2026');
    localStorage.removeItem('materia.deadlines.view');
    TestBed.resetTestingModule();
  });

  describe('a long list (SEC-07c)', () => {
    const QUILL = MATTER.replace('m-whitfield', 'm-quill');
    const COUNT = 210;
    const dueOn = (i: number) => new Date(Date.UTC(2026, 9, 5 + i)).toISOString().slice(0, 10);

    /**
     * 210 upcoming deadlines, one a day from 5 October, on a matter nobody here can read: each names
     * it from its copy. Every tenth is mine. Whitfield's notice (8 October) has no copy yet.
     */
    function seedMany(fs: Fs): void {
      for (let i = 0; i < COUNT; i++) {
        fs.set(
          `${QUILL}/deadlines/q-${i}`,
          deadlineDoc(`Quill step ${i}`, {
            kind: 'internal',
            dueDate: dueOn(i),
            matterId: 'm-quill',
            assigneeUid: i % 10 ? PRIYA : ME,
            matter: {
              number: 'HV-2026-0200',
              title: 'Estate of Fictional Quill',
              jurisdiction: 'VIC',
              responsibleUid: PRIYA,
              teamUids: [PRIYA],
            },
          }),
        );
      }
    }

    const rendered = (page: Page) => page.body.querySelectorAll('section[data-group] li').length;
    const shown = (page: Page) =>
      page.body.querySelectorAll('section[data-group]:not([data-empty]) li:not([data-filtered]) mt-deadline-row')
        .length;
    const later = (page: Page) => page.text(page.body.querySelector('section[data-group="later"] h2'));
    const more = (page: Page) => page.body.querySelector('.mt-deadlines-page .more');

    it('loads a page at a time as the list scrolls, or on the button while filtered', async () => {
      const observers: { report: IntersectionObserverCallback; targets: Element[]; live: boolean }[] = [];
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          private readonly entry: (typeof observers)[number];
          constructor(report: IntersectionObserverCallback) {
            this.entry = { report, targets: [], live: true };
            observers.push(this.entry);
          }
          observe(target: Element): void {
            this.entry.targets.push(target);
          }
          unobserve(): void {
            // Nothing to release.
          }
          disconnect(): void {
            this.entry.live = false;
          }
        },
      );
      /** The end of the list comes into view. */
      const scrollToEnd = async (page: Page) => {
        for (const { report, targets, live } of observers) {
          if (live) {
            report(
              targets.map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry),
              {} as IntersectionObserver,
            );
          }
        }
        await page.stable(20);
      };
      try {
        const page = await openMatter('/deadlines', { configure: seedMany, flags: RULES_ON });
        await page.stable(20);
        // The first page: the notice and the next 99 days, the last group marked as going on.
        expect(rendered(page)).toBe(100);
        expect(later(page)).toMatch(/\d+\+$/);
        expect(page.text(row(page, 'q-0'))).toContain('HV-2026-0200 · Estate of Fictional Quill');
        expect(page.text(row(page, 'd-notice'))).toContain('M-2026-0142 · Estate of Margaret Whitfield');

        await scrollToEnd(page);
        expect(rendered(page)).toBe(200);

        // Filtered, a short list doesn't load the rest on its own: the button does.
        await page.click('Mine');
        expect(shown(page)).toBe(21);
        expect(page.text(more(page))).toContain(
          `These filters cover the deadlines due by ${formatDateOnly(dueOn(198))}`,
        );
        await scrollToEnd(page);
        expect(rendered(page)).toBe(200);
        await page.click('Kind');
        await page.click('Court');
        expect(shown(page)).toBe(0);
        expect(page.text(more(page))).toContain('Nothing matches these filters among the deadlines due by');
        expect(page.text(page.body)).not.toContain('No deadlines match');
        await page.click('Show later deadlines');
        await page.stable(20);
        expect(rendered(page)).toBe(COUNT + 1);
        expect(more(page)).toBeNull();
        expect(page.text(page.body)).toContain('No deadlines match');

        await page.click('Clear filters');
        expect(shown(page)).toBe(COUNT + 1);
        expect(later(page)).toMatch(/\d$/);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('reads the calendar a month at a time', async () => {
      localStorage.setItem('materia.deadlines.view', 'calendar');
      try {
        const page = await openMatter('/deadlines', { configure: seedMany, flags: RULES_ON });
        await page.stable(20);
        const calendar = page.body.querySelector('mt-deadline-calendar');
        expect(page.text(calendar?.querySelector('td[data-date="2026-10-08"]'))).toContain(
          'Advertise notice of intended application',
        );
        for (let i = 0; i < 6; i++) await page.click('Next month');
        await page.stable(20);
        expect(page.text(calendar?.querySelector('h3'))).toBe('April 2027');
        // Far past the list's first page, and only that month's days read.
        expect(page.text(calendar?.querySelector(`td[data-date="${dueOn(200)}"]`))).toContain('Quill step 200');
        expect(page.body.querySelector('section[data-group]')).toBeNull();
      } finally {
        localStorage.removeItem('materia.deadlines.view');
        TestBed.resetTestingModule();
      }
    });
  });
});

describe('deadline view helpers', () => {
  it('words months, recompute results and refusals', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(monthLabel('2026-10')).toBe('October 2026');
    expect(recomputeSummaryText({ proposed: ['a', 'b'], created: [] })).toBe('2 deadline changes need review');
    expect(recomputeSummaryText({ proposed: [], created: [] })).toBe('');
    expect(deadlineErrorCopy(new DomainError('FAILED_PRECONDITION', 'x', { reason: 'change_not_pending' }))).toBe(
      'Someone has already decided this change.',
    );
    expect(
      deadlineErrorCopy(
        new DomainError('INVALID_ARGUMENT', 'x', { fields: { confirmation: ['Type the matter number exactly'] } }),
      ),
    ).toBe('Type the matter number exactly.');
    expect(deadlineErrorCopy(new DomainError('NOT_FOUND', 'x'))).toContain('couldn’t find');
  });

  it('knows when a snapshot left a row’s data as it was (SEC-07c)', () => {
    const at = (iso: string) => new Date(iso);
    const row = {
      title: 'Fictional step',
      dueDate: '2026-10-08',
      reminders: [{ days: 7 }],
      computed: { trace: ['a', 'b'] },
      updatedAt: at('2026-10-01T00:00:00Z'),
      override: undefined,
    };
    const again = structuredClone({ ...row, updatedAt: at('2026-10-01T00:00:00Z') });
    expect(sameData(row, again)).toBe(true);
    expect(sameData({ ...row, override: undefined }, { ...row, override: undefined, extra: undefined })).toBe(true);
    expect(sameData(row, { ...again, updatedAt: at('2026-10-02T00:00:00Z') })).toBe(false);
    expect(sameData(row, { ...again, reminders: [{ days: 3 }] })).toBe(false);
    expect(sameData(row, { ...again, computed: { trace: ['a'] } })).toBe(false);
    expect(sameData(row, { ...again, title: 'Another' })).toBe(false);
    expect(sameData(undefined, undefined)).toBe(true);
    expect(sameData(undefined, { id: 'm' })).toBe(false);
    expect(sameData(['a'], { 0: 'a' })).toBe(false);
    expect(sameData(at('2026-10-01T00:00:00Z'), '2026-10-01')).toBe(false);
  });
});
