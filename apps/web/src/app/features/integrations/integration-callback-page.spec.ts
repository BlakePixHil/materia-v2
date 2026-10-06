import { Location } from '@angular/common';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { DomainError } from '@materia/domain';
import { ToastService } from '@materia/ui';

import { IntegrationCallbackPage } from './integration-callback-page';
import { CALLABLES } from '../../core/data/callables';

@Component({ template: 'Billing settings' })
class Landing {}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The OAuth callback route (INT-01): finishes connecting with the code and state the provider sent
 * back, as the signed-in person. Fictional data only.
 */
async function open(url: string, answer: (data: Record<string, unknown>) => Promise<unknown>) {
  const calls: { name: string; data: Record<string, unknown>; options: unknown }[] = [];
  const toasts: { title: string; description?: string }[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'integrations/callback/:provider', component: IntegrationCallbackPage },
        { path: 'settings/billing', component: Landing },
        { path: 'settings', component: Landing },
      ]),
      {
        provide: CALLABLES,
        useValue: {
          call: async (name: string, data: Record<string, unknown>, options: unknown) => {
            calls.push({ name, data, options });
            return answer(data);
          },
        },
      },
      { provide: ToastService, useValue: { show: (toast: { title: string }) => void toasts.push(toast) } },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  await settle();
  await harness.fixture.whenStable();
  harness.detectChanges();
  const text = () => (harness.routeNativeElement?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return { harness, calls, toasts, text, router: TestBed.inject(Router), location: TestBed.inject(Location) };
}

describe('IntegrationCallbackPage', () => {
  it('completes the connection and goes back to where it started, leaving no code in the history', async () => {
    const page = await open('/integrations/callback/xero?code=fake-code.abc&state=state-1', async () => ({
      provider: 'xero',
      returnTo: '/settings/billing',
      account: { tenantName: 'Harbour & Vine Legal (demo)' },
    }));
    expect(page.calls).toEqual([
      {
        name: 'integrations-complete',
        data: { provider: 'xero', state: 'state-1', code: 'fake-code.abc' },
        options: { idempotent: true },
      },
    ]);
    expect(page.router.url).toBe('/settings/billing');
    expect(page.toasts).toEqual([
      { title: 'Xero connected', description: 'Connected as Harbour & Vine Legal (demo).', tone: 'success' },
    ]);
  });

  it('explains a declined consent without calling the server', async () => {
    const page = await open('/integrations/callback/xero?error=access_denied&state=s', async () => ({}));
    expect(page.calls).toEqual([]);
    expect(page.text()).toContain('Xero isn’t connected');
    expect(page.text()).toContain('Materia wasn’t given access to Xero');
  });

  it('shows why the server refused, and takes the code off the address bar', async () => {
    const page = await open('/integrations/callback/microsoft?code=c1&state=s1', async () => {
      throw new DomainError('INTEGRATION_STATE_INVALID');
    });
    expect(page.text()).toContain('Microsoft 365 isn’t connected');
    expect(page.text()).toContain('That connection link has expired or was already used');
    expect(page.location.path()).toBe('/integrations/callback/microsoft');
  });

  it('refuses a provider it doesn’t know and an incomplete link', async () => {
    const unknown = await open('/integrations/callback/myob?code=c&state=s', async () => ({}));
    expect(unknown.calls).toEqual([]);
    expect(unknown.text()).toContain('isn’t an integration Materia knows');
    TestBed.resetTestingModule();
    const partial = await open('/integrations/callback/xero?state=s', async () => ({}));
    expect(partial.calls).toEqual([]);
    expect(partial.text()).toContain('This connection link is incomplete');
  });
});
