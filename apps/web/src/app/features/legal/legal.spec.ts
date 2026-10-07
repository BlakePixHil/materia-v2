import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT, type SessionSecurity } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { DomainError, LEGAL_DOCUMENTS, resolveSecurity, TERMS_VERSION } from '@materia/domain';
import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import { LEGAL_CONTENT } from './legal-content.generated';
import { headingId, parseLegalMarkdown, sectionBlocks, type LegalBlock } from './legal-markdown';
import { longDate } from './legal-meta';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT, type AuthSession } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { TERMS_OUTDATED_COPY } from '../../core/error-copy';
import { provideTestFlags } from '../../core/flags/testing';
import { FakeTenancyPort } from '../../core/orgs/testing';

/** The legal pages and terms acceptance (SEC-01). Fictional data only. */

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const OWNER = testSession({ claims: { orgId: 'org-harbour-vine', role: 'owner', orgName: 'Harbour & Vine Legal' } });

function security(termsAcceptedVersion: string | null): SessionSecurity {
  return {
    policy: resolveSecurity({ mfaRequired: false, sessionIdleMinutes: 60 }),
    validAfter: null,
    termsAcceptedVersion,
  };
}

async function open(url: string, session: AuthSession | null, configure?: (port: FakeAuthPort) => void) {
  const port = new FakeAuthPort(session);
  const tenancy = new FakeTenancyPort();
  tenancy.security_ = security(null);
  configure?.(port);
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      { provide: AUTH_PORT, useValue: port },
      { provide: TENANCY_PORT, useValue: tenancy },
      provideInMemoryFirestore(new InMemoryFirestore()),
      ...provideTestFlags(),
    ],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  const el = fixture.nativeElement as HTMLElement;
  const stable = async () => {
    await settle();
    await fixture.whenStable();
    await settle();
  };
  await router.navigateByUrl(url);
  await stable();
  return {
    port,
    tenancy,
    router,
    el,
    stable,
    text: () => el.textContent?.replace(/\s+/g, ' ') ?? '',
    headings: (level: string) => [...el.querySelectorAll(level)].map((h) => h.textContent?.trim()),
  };
}

describe('legal Markdown', () => {
  it('reads headings with ids, paragraphs, lists, quotes, code and tables', () => {
    const blocks = parseLegalMarkdown(
      [
        '## Who we are',
        '',
        'We run **Materia**. See the [terms](/legal/terms) and [the OAIC](https://www.oaic.gov.au).',
        'A second line of the same paragraph.',
        '',
        '### Who we are',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '2. second',
        '',
        '> quoted',
        '>',
        '> again',
        '',
        '```',
        '<b>literal</b>',
        '```',
        '',
        '## Providers',
        '',
        '| Provider | Where |',
        '| --- | --- |',
        '| Fictional Cloud | `australia-southeast1` |',
        '| [Link](javascript:void) | Nowhere |',
      ].join('\n'),
    );
    expect(blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'list',
      'list',
      'quote',
      'code',
      'heading',
      'table',
    ]);
    const headings = blocks.filter(
      (block): block is Extract<LegalBlock, { type: 'heading' }> => block.type === 'heading',
    );
    expect(headings.map((h) => [h.level, h.id])).toEqual([
      [2, 'who-we-are'],
      [3, 'who-we-are-2'],
      [2, 'providers'],
    ]);
    const paragraph = blocks[1] as Extract<LegalBlock, { type: 'paragraph' }>;
    expect(paragraph.children).toContainEqual({
      type: 'link',
      href: '/legal/terms',
      children: [{ type: 'text', text: 'terms' }],
    });
    expect(paragraph.children).toContainEqual(
      expect.objectContaining({ type: 'link', href: 'https://www.oaic.gov.au' }),
    );
    expect((blocks[4] as Extract<LegalBlock, { type: 'list' }>).ordered).toBe(true);
    expect((blocks[5] as Extract<LegalBlock, { type: 'quote' }>).paragraphs).toHaveLength(2);
    expect(blocks[6]).toEqual({ type: 'code', text: '<b>literal</b>' });
    const table = blocks[8] as Extract<LegalBlock, { type: 'table' }>;
    expect(table.labelledBy).toBe('providers');
    expect(table.header).toHaveLength(2);
    expect(table.rows).toHaveLength(2);
    // An unsafe link is its text only.
    expect(table.rows[1]?.[0]).toEqual([{ type: 'text', text: 'Link' }]);
  });

  it('names headings for their ids', () => {
    expect(headingId('1. The agreement')).toBe('1-the-agreement');
    expect(headingId('APP 8: Cross-border disclosure')).toBe('app-8-cross-border-disclosure');
    expect(headingId('???')).toBe('section');
  });

  it('finds a section by its heading', () => {
    const blocks = parseLegalMarkdown('## Summary\n\nIn brief.\n\n### Detail\n\nMore.\n\n## 1. Next\n\nNot this.');
    expect(sectionBlocks(blocks, 'Summary').map((block) => block.type)).toEqual(['paragraph', 'heading', 'paragraph']);
    expect(sectionBlocks(blocks, 'Missing')).toEqual([]);
  });

  it('parses every published document, without its title or draft notice', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const text = LEGAL_CONTENT[doc.key as keyof typeof LEGAL_CONTENT];
      expect(text, doc.key).toBeTruthy();
      const blocks = parseLegalMarkdown(text);
      expect(
        blocks.some((block) => block.type === 'heading' && block.level === 2),
        doc.key,
      ).toBe(true);
      // The page shows the title (h1) and the draft notice itself.
      expect(text, doc.key).not.toMatch(/^# /m);
      expect(text, doc.key).not.toContain('Draft — not yet reviewed');
    }
    expect(sectionBlocks(parseLegalMarkdown(LEGAL_CONTENT.terms), 'Summary').length).toBeGreaterThan(0);
  });

  it('writes dates out in full', () => {
    expect(longDate('2026-10-07')).toBe('7 October 2026');
  });
});

describe('legal pages (SEC-01)', () => {
  it('lists every document at /legal, signed out', async () => {
    const page = await open('/legal', null);
    expect(page.router.url).toBe('/legal');
    expect(page.headings('h1')).toEqual(['Legal']);
    for (const doc of LEGAL_DOCUMENTS) {
      const link = page.el.querySelector(`a[href="/legal/${doc.key}"]`);
      expect(link?.textContent?.trim(), doc.key).toBe(doc.title);
    }
    expect(page.text()).toContain('Draft — not yet reviewed.');
  });

  it('shows a document with its version, effective date and draft notice', async () => {
    const page = await open('/legal/subprocessors', null);
    expect(page.headings('h1')).toEqual(['Sub-processor list']);
    expect(page.text()).toContain(`Version ${TERMS_VERSION} · Effective 7 October 2026`);
    expect(page.el.querySelector('mt-note[data-tone="warning"]')?.textContent).toContain('Draft — not yet reviewed.');
    expect(page.headings('h2')).toContain('Engaged by us for every firm');
    // Tables scroll in a region named by their heading, with column headers.
    const region = page.el.querySelector('.mt-legal-table');
    expect(region?.getAttribute('role')).toBe('region');
    expect(region?.getAttribute('tabindex')).toBe('0');
    expect(page.el.querySelector(`#${region?.getAttribute('aria-labelledby')}`)?.tagName).toBe('H2');
    expect(page.el.querySelectorAll('th[scope="col"]').length).toBeGreaterThan(0);
    expect(page.text()).toContain('Resend, Inc.');
    // Links to other documents stay in the app; the others link back.
    expect(page.el.querySelector('mt-legal-prose a[href="/legal/dpa"]')?.getAttribute('target')).toBeNull();
    const others = [...page.el.querySelectorAll('nav[aria-label="Other legal documents"] a')].map((a) =>
      a.getAttribute('href'),
    );
    expect(others).toHaveLength(LEGAL_DOCUMENTS.length - 1);
    expect(others).not.toContain('/legal/subprocessors');
  });

  it('opens outside links in a new tab', async () => {
    const page = await open('/legal/privacy', null);
    const oaic = page.el.querySelector('mt-legal-prose a[href="https://www.oaic.gov.au"]');
    expect(oaic?.getAttribute('target')).toBe('_blank');
    expect(oaic?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('sends an unknown document to the index', async () => {
    const page = await open('/legal/no-such-document', null);
    expect(page.router.url).toBe('/legal');
  });

  it('links the privacy policy and terms from the sign-in page', async () => {
    const page = await open('/auth/sign-in', null);
    const nav = page.el.querySelector('nav[aria-label="Legal"]');
    expect(nav?.querySelector('a[href="/legal/privacy"]')?.textContent?.trim()).toBe('Privacy policy');
    expect(nav?.querySelector('a[href="/legal/terms"]')?.textContent?.trim()).toBe('Terms of service');
  });

  it('works signed in too, without the terms gate', async () => {
    const page = await open('/legal/terms', OWNER);
    expect(page.router.url).toBe('/legal/terms');
    expect(page.headings('h1')).toEqual(['Terms of service']);
  });
});

describe('accepting the terms (SEC-01)', () => {
  const tick = async (page: Awaited<ReturnType<typeof open>>) => {
    page.el.querySelector<HTMLElement>('mt-checkbox [role="checkbox"]')?.click();
    await page.stable();
  };
  const submit = async (page: Awaited<ReturnType<typeof open>>) => {
    page.el.querySelector('form')?.dispatchEvent(new Event('submit'));
    await page.stable();
  };

  it('shows the summary, needs the box ticked, records the acceptance and goes on', async () => {
    const page = await open('/matters/m-1/overview', OWNER, (port) => {
      port.callResults['orgs-acceptTerms'] = { version: TERMS_VERSION, recorded: true };
    });
    expect(page.router.url).toBe('/accept-terms?returnUrl=%2Fmatters%2Fm-1%2Foverview');
    expect(page.headings('h1')).toEqual(['Accept the terms for Harbour & Vine Legal']);
    expect(page.text()).toContain('This summary is part of the terms');
    expect(page.el.querySelector('a[href="/legal/terms"][target="_blank"]')).not.toBeNull();
    expect(page.el.querySelector('a[href="/legal/dpa"][target="_blank"]')).not.toBeNull();

    await submit(page);
    expect(page.text()).toContain('Tick this box to continue.');
    expect(page.port.calls.filter((call) => call.name === 'orgs-acceptTerms')).toEqual([]);

    await tick(page);
    await submit(page);
    const call = page.port.calls.find((c) => c.name === 'orgs-acceptTerms');
    expect(call?.data).toMatchObject({ version: TERMS_VERSION });
    expect((call?.data as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.router.url).toBe('/matters/m-1/overview');
  });

  it('asks for a reload when the terms changed meanwhile', async () => {
    const page = await open('/today', OWNER, (port) => {
      port.call = async () => {
        throw new DomainError('FAILED_PRECONDITION', 'old', { reason: 'terms_outdated', current: '9.9' });
      };
    });
    expect(page.router.url).toBe('/accept-terms?returnUrl=%2Ftoday');
    await tick(page);
    await submit(page);
    expect(page.text()).toContain(TERMS_OUTDATED_COPY);
    expect(page.router.url).toBe('/accept-terms?returnUrl=%2Ftoday');
  });

  it('never asks a lawyer', async () => {
    const page = await open('/today', testSession());
    expect(page.router.url).toBe('/today');
  });
});
