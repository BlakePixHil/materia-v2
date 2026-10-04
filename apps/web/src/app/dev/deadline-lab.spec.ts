import { TestBed } from '@angular/core/testing';

import { DeadlineLabPage } from './deadline-lab';

type Lab = { form: { patchValue(v: object): void } };

async function setup(values: object): Promise<HTMLElement> {
  const fixture = TestBed.createComponent(DeadlineLabPage);
  (fixture.componentInstance as unknown as Lab).form.patchValue(values);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('DeadlineLabPage', () => {
  it('computes deadlines and traces from the events entered', async () => {
    const el = await setup({ today: '2026-10-04', date_of_death: '2025-12-01', grant_issued: '2026-05-03' });
    const items = [...el.querySelectorAll<HTMLElement>('ul[aria-label="Computed deadlines"] > li')];
    const fp = items.find((li) => li.textContent?.includes('Family provision claim period ends'));
    expect(fp?.textContent).toContain('2026-11-04');
    expect(fp?.querySelector('ol[aria-label="Trace"]')?.textContent).toContain(
      '2026-11-03 is Melbourne Cup on VIC_SUPREME_COURT',
    );
    expect(el.textContent).toContain('Illustrative until a practising Victorian');
  });

  it('shows blocked rules', async () => {
    const el = await setup({ today: '2026-10-04', date_of_death: '2025-12-01' });
    expect(el.textContent).toContain('blocked: No grant yet');
  });

  it('shows calendar errors loudly instead of guessing', async () => {
    const el = await setup({ today: '2028-07-02', date_of_death: '2028-01-01', grant_issued: '2028-07-01' });
    expect(el.textContent).toContain('CALENDAR_MISSING');
  });
});
