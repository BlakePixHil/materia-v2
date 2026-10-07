import type { DateOnly } from '@materia/domain';

import { disclosureLines } from './disclosures-page';
import { cleanUpOverlays, MATTER, meta, ORG, openMatter, PARALEGAL, TODAY } from '../matter-detail/testing';

/** BILL-06: the costs disclosure panel on the Overview, its dialogs and the report. Fictional data only. */

afterEach(cleanUpOverlays);

const ON = { 'billing.costsDisclosure': true };
const fee = { arrangement: 'fixed', amountCents: 450_000, revision: 0, history: [] };
const required = {
  status: 'required',
  requirement: 'full',
  bandId: 'full',
  rulesVersion: 'vic-v1',
  basisEstimateCents: 450_000,
  requiredSince: '2026-09-25',
  history: [
    {
      at: new Date('2026-09-25T00:00:00Z'),
      by: 'user-jordan',
      action: 'assessed',
      status: 'required',
      requirement: 'full',
      estimateCents: 450_000,
    },
  ],
};
const panel = () => document.body.querySelector<HTMLElement>('[data-testid="disclosure-panel"]');
const part = (id: string) => panel()?.querySelector(`[data-testid="${id}"]`);

describe('costs disclosure panel', () => {
  it('stays hidden while the flag is off', async () => {
    const page = await openMatter(undefined, { matter: { fee, costsDisclosure: required } });
    await page.stable(50);
    expect(panel()).toBeNull();
  });

  it('stays hidden from paralegals (billing roles only)', async () => {
    const page = await openMatter(undefined, {
      session: PARALEGAL,
      flags: ON,
      matter: { fee, costsDisclosure: required },
    });
    await page.stable(50);
    expect(panel()).toBeNull();
  });

  it('shows the status, what the estimate needs, the illustrative rules and the history', async () => {
    const page = await openMatter(undefined, { flags: ON, matter: { fee, costsDisclosure: required } });
    await page.stable(50);
    expect(page.text(part('disclosure-status'))).toBe('Required');
    expect(page.text(part('disclosure-need'))).toBe('Full disclosure required (estimate $4,500.00)');
    expect(page.text(panel())).toContain(
      'The VIC disclosure rules are illustrative until a practitioner reviews them.',
    );
    expect(page.text(part('disclosure-due'))).toContain('Due since');
    expect(page.text(panel()?.querySelector('details'))).toContain(
      'Assessed at intake · full disclosure · estimate $4,500.00',
    );
    expect(page.buttons('Generate disclosure', panel() ?? undefined)).toHaveLength(1);
    expect(page.buttons('Record as sent', panel() ?? undefined)).toHaveLength(1);
    expect(page.buttons('No disclosure needed', panel() ?? undefined)).toHaveLength(1);
  });

  it('generates the disclosure through costs-generateDisclosure', async () => {
    const page = await openMatter(undefined, {
      flags: ON,
      matter: { fee, costsDisclosure: required },
      callables: {
        'costs-generateDisclosure': (data, fs) => {
          fs.set(MATTER, { ...(fs.get(MATTER) ?? {}), costsDisclosure: { ...required, documentId: 'd-cd' }, ...meta });
          return {
            matterId: data['matterId'],
            documentId: 'd-cd',
            name: 'Costs disclosure 4 October 2026.docx',
            templateId: 'system-costs-disclosure',
            missing: [],
          };
        },
      },
    });
    await page.stable(50);
    await page.click('Generate disclosure', panel() ?? undefined);
    await page.stable(50);
    expect(page.calls('costs-generateDisclosure')).toEqual([expect.objectContaining({ matterId: 'm-whitfield' })]);
    expect(page.text()).toContain('Costs disclosure 4 October 2026.docx added to Documents');
    expect(page.text(panel())).toContain('Open the latest generated disclosure');
  });

  it('records it as sent with the date and method, refusing a date after today', async () => {
    const page = await openMatter(undefined, {
      flags: ON,
      matter: { fee, costsDisclosure: { ...required, documentId: 'd-cd' } },
      callables: {
        'costs-markDisclosureSent': (data, fs) => {
          fs.set(MATTER, {
            ...(fs.get(MATTER) ?? {}),
            costsDisclosure: {
              ...required,
              status: 'sent',
              sentOn: data['sentOn'],
              sentMethod: data['method'],
              sentEstimateCents: 450_000,
            },
            ...meta,
          });
          return { matterId: data['matterId'], status: 'sent' };
        },
      },
    });
    await page.stable(50);
    await page.click('Record as sent', panel() ?? undefined);
    await page.openedDialog();
    await page.fill('Date sent', '05/10/2026');
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('can’t be after today');
    expect(page.calls('costs-markDisclosureSent')).toHaveLength(0);
    await page.fill('Date sent', '03/10/2026');
    await page.fill('Sent by', '1');
    await page.submit(page.dialog());
    await page.stable(50);
    expect(page.calls('costs-markDisclosureSent')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', sentOn: '2026-10-03', method: 'post', documentId: 'd-cd' }),
    ]);
    expect(page.dialog()).toBeNull();
    expect(page.text(part('disclosure-status'))).toBe('Sent');
    expect(page.text(part('disclosure-sent'))).toContain('by post, on an estimate of $4,500.00');
  });

  it('records that none is needed with the reason; "other" needs a note', async () => {
    const page = await openMatter(undefined, {
      flags: ON,
      matter: { fee, costsDisclosure: required },
      callables: {
        'costs-setDisclosureWaiver': (data, fs) => {
          const waiver = data['waiver'] as Record<string, unknown>;
          fs.set(MATTER, {
            ...(fs.get(MATTER) ?? {}),
            costsDisclosure: {
              status: 'waived',
              waiver: { ...waiver, by: 'user-jordan', at: new Date() },
              history: [],
            },
            ...meta,
          });
          return { matterId: data['matterId'], status: 'waived' };
        },
      },
    });
    await page.stable(50);
    await page.click('No disclosure needed', panel() ?? undefined);
    await page.openedDialog();
    await page.fill('Why no disclosure is needed', '2');
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('Say why no disclosure is needed.');
    await page.fill('Note', 'Retainer with the bank covers it');
    await page.submit(page.dialog());
    await page.stable(50);
    expect(page.calls('costs-setDisclosureWaiver')).toEqual([
      expect.objectContaining({ waiver: { reason: 'other', note: 'Retainer with the bank covers it' } }),
    ]);
    expect(page.text(part('disclosure-waiver'))).toContain('Other reason: Retainer with the bank covers it');
    expect(page.buttons('A disclosure is needed after all', panel() ?? undefined)).toHaveLength(1);
    expect(page.buttons('Generate disclosure', panel() ?? undefined)).toHaveLength(0);
  });

  it('says why an updated disclosure is needed', async () => {
    const page = await openMatter(undefined, {
      flags: ON,
      matter: {
        fee,
        costsDisclosure: {
          ...required,
          status: 'update_required',
          sentOn: '2026-08-01',
          sentMethod: 'email',
          sentEstimateCents: 300_000,
          updateReasons: ['band', 'increase'],
        },
      },
    });
    await page.stable(50);
    expect(page.text(part('disclosure-status'))).toBe('Update required');
    expect(page.text(part('disclosure-update'))).toContain(
      'the estimate moved to a different disclosure band and the estimate went up by more than the practice’s threshold',
    );
    expect(page.buttons('Generate updated disclosure', panel() ?? undefined)).toHaveLength(1);
  });
});

describe('costs disclosures report', () => {
  const row = (id: string, extra: Record<string, unknown> = {}, disclosure: Record<string, unknown> = {}) => ({
    id,
    number: `M-2026-${id}`,
    title: `Estate ${id}`,
    type: 'probate' as const,
    status: 'open' as const,
    jurisdiction: 'VIC' as const,
    responsibleUid: 'user-jordan',
    privileged: false,
    deletedAt: null,
    costsDisclosure: { ...required, ...disclosure } as never,
    ...extra,
  });

  it('lists live outstanding disclosures, oldest first, marking those past the 7-day reminder', () => {
    const lines = disclosureLines(
      [
        row('0003', {}, { requiredSince: '2026-10-01' }),
        row('0001', {}, { requiredSince: '2026-09-20' }),
        row('0002', {}, { status: 'update_required', updateReasons: ['increase'], requiredSince: '2026-09-30' }),
        row('0004', { status: 'closed' }),
        row('0005', { deletedAt: new Date() }),
        row('0006', {}, { status: 'sent' }),
      ] as never,
      TODAY as DateOnly,
    );
    expect(lines.map((line) => [line.number, line.overdue])).toEqual([
      ['M-2026-0001', true],
      ['M-2026-0002', true],
      ['M-2026-0003', false],
    ]);
    expect(lines[1]?.why).toBe('the estimate went up by more than the practice’s threshold');
  });

  it('shows the report to billing roles behind the flag, linked from Time and billing', async () => {
    const page = await openMatter('/billing/disclosures', {
      flags: ON,
      matter: { fee, costsDisclosure: required },
      configure: (fs) => {
        fs.set(`orgs/${ORG}/matters/m-other`, {
          ...(fs.get(MATTER) ?? {}),
          number: 'M-2026-0150',
          title: 'Estate of Harold Finch',
          responsibleUid: 'user-priya',
          costsDisclosure: { ...required, requiredSince: '2026-10-02' },
        });
      },
    });
    await page.stable(50);
    const rows = [...page.body.querySelectorAll('[data-testid="disclosure-row"]')].map((r) => page.text(r));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('M-2026-0142');
    expect(rows[0]).toContain('Jordan Price');
    expect(rows[0]).toContain('Overdue');
    expect(rows[1]).toContain('M-2026-0150');
    expect(page.text(page.body.querySelector('[data-testid="disclosures-count"]'))).toBe('2 outstanding, 1 overdue');

    await page.router.navigateByUrl('/billing');
    await page.stable(50);
    expect(page.buttons('Costs disclosures')).toHaveLength(1);
  });
});
