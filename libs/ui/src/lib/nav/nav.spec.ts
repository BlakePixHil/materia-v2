import { Component } from '@angular/core';
import { provideRouter, RouterLink } from '@angular/router';
import { render, screen, waitFor } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtBreadcrumb, MtNavItem, MtTabBar } from './nav';

@Component({ template: '' })
class Blank {}

const routes = [
  { path: 'today', component: Blank },
  { path: 'matters', component: Blank },
  { path: 'record', component: Blank },
  { path: 'clerk', component: Blank },
  { path: 'inbox', component: Blank },
];

describe('MtNavItem', () => {
  @Component({
    imports: [MtNavItem, RouterLink],
    template: `
      <a mtNavItem routerLink="/today" icon="today" label="Today" [count]="250"></a>
      <a mtNavItem routerLink="/inbox" icon="inbox" label="Inbox" [count]="4"></a>
      <a mtNavItem routerLink="/matters" icon="matters" label="Matters" collapsed></a>
    `,
  })
  class Host {}

  it('marks the active route, shows counts, and collapses to an icon with a tooltip', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { navigate } = await render(Host, { providers: [provideRouter(routes)] });
    await navigate('/inbox');
    const inbox = screen.getByRole('link', { name: /Inbox/ });
    await waitFor(() => expect(inbox).toHaveAttribute('data-active'));
    expect(inbox).toHaveAttribute('aria-current', 'page');
    expect(inbox.querySelector('.mt-nav-count')).toHaveTextContent('4');
    const todayLink = screen.getByRole('link', { name: /Today/ });
    expect(todayLink).not.toHaveAttribute('data-active');
    // Past 99 the count reads 99+.
    expect(todayLink.querySelector('.mt-nav-count')).toHaveTextContent('99+');

    const matters = screen.getByRole('link', { name: 'Matters' });
    expect(matters).toHaveAttribute('aria-label', 'Matters');
    expect(matters.textContent?.trim()).toBe('');
    matters.focus();
    await vi.advanceTimersByTimeAsync(450);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Matters');
    vi.useRealTimers();
  });
});

describe('MtBreadcrumb', () => {
  it('marks the last crumb as the current page and links the others', async () => {
    await render(
      `<mt-breadcrumb [items]="[{ label: 'Matters', link: '/matters' }, { label: 'WE-142', link: '/matters/142', ref: true }, { label: 'Deadlines' }]" />`,
      { imports: [MtBreadcrumb], providers: [provideRouter(routes)] },
    );
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Matters' })).toHaveAttribute('href', '/matters');
    expect(screen.getByRole('link', { name: 'WE-142' })).toHaveClass('ref');
    expect(screen.getByText('Deadlines')).toHaveAttribute('aria-current', 'page');
  });

  it('collapses the middle of a long path and expands it on click', async () => {
    await render(
      `<mt-breadcrumb [items]="[{ label: 'Workspace', link: '/' }, { label: 'Matters', link: '/matters' }, { label: 'WE-142', link: '/m/142' }, { label: 'Documents', link: '/m/142/docs' }, { label: 'Will.pdf' }]" />`,
      { imports: [MtBreadcrumb], providers: [provideRouter(routes)] },
    );
    expect(screen.queryByText('Matters')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    await userEvent.click(screen.getByRole('button', { name: 'Show the full path' }));
    expect(screen.getByText('Matters')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });
});

describe('MtTabBar', () => {
  it('shows at most five destinations, raises the centre action and marks the active route', async () => {
    const items = [
      { label: 'Today', icon: 'today', link: '/today' },
      { label: 'Matters', icon: 'matters', link: '/matters' },
      { label: 'Record', icon: 'mic', link: '/record', fab: true },
      { label: 'Clerk', icon: 'sparkle', link: '/clerk' },
      { label: 'Inbox', icon: 'inbox', link: '/inbox' },
      { label: 'Extra', icon: 'settings', link: '/today' },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { navigate } = await render(`<mt-tab-bar [items]="items" />`, {
      imports: [MtTabBar],
      providers: [provideRouter(routes)],
      componentProperties: { items },
    });
    await navigate('/matters');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav).toHaveClass('mt-tabbar');
    expect(screen.getAllByRole('link')).toHaveLength(5);
    expect(screen.queryByRole('link', { name: 'Extra' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Record' }).querySelector('.fab')).not.toBeNull();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Matters' })).toHaveAttribute('aria-current', 'page'));
    warn.mockRestore();
  });
});
