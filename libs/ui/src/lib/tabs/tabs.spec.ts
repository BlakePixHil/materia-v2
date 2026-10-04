import { Component, signal } from '@angular/core';
import { provideRouter, RouterLink } from '@angular/router';
import { render, screen, waitFor } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MT_TABS } from './tabs';

@Component({ template: '' })
class Blank {}

describe('MtTabs', () => {
  @Component({
    imports: [...MT_TABS],
    template: `
      <div mtTabset [(mtTabsetValue)]="tab">
        <div mtTabList aria-label="Matter sections">
          <button mtTab value="overview">Overview</button>
          <button mtTab value="deadlines" [count]="3">Deadlines</button>
          <button mtTab value="estate" disabled>Estate</button>
          <button mtTab value="documents">Documents</button>
        </div>
        <div mtTabPanel value="overview">Overview panel</div>
        <div mtTabPanel value="deadlines">Deadlines panel</div>
        <div mtTabPanel value="documents">Documents panel</div>
      </div>
    `,
  })
  class Host {
    readonly tab = signal('overview');
  }

  it('renders a labelled tablist with counts and the active tab marked', async () => {
    await render(Host);
    expect(screen.getByRole('tablist', { name: 'Matter sections' })).toHaveClass('mt-tabs');
    const overview = screen.getByRole('tab', { name: 'Overview' });
    expect(overview).toHaveClass('mt-tab');
    expect(overview).toHaveAttribute('aria-selected', 'true');
    expect(overview).toHaveAttribute('data-active');
    expect(screen.getByRole('tab', { name: /Deadlines/ }).querySelector('.mt-count')).toHaveTextContent('3');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Overview panel');
  });

  it('moves with arrows, skips disabled tabs, jumps with Home/End and syncs the value', async () => {
    const { fixture } = await render(Host);
    screen.getByRole('tab', { name: 'Overview' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Deadlines/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveFocus();
    await waitFor(() => expect(fixture.componentInstance.tab()).toBe('documents'));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Documents panel');
  });

  it('router-linked tabs take the active tab from the URL', async () => {
    @Component({
      imports: [...MT_TABS, RouterLink],
      template: `
        <nav mtTabNav aria-label="Matter sections">
          <a mtTabLink routerLink="/overview">Overview</a>
          <a mtTabLink routerLink="/deadlines" [count]="3">Deadlines</a>
        </nav>
      `,
    })
    class LinkHost {}
    const { navigate } = await render(LinkHost, {
      providers: [
        provideRouter([
          { path: 'overview', component: Blank },
          { path: 'deadlines', component: Blank },
        ]),
      ],
    });
    await navigate('/deadlines');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Deadlines/ })).toHaveAttribute('aria-current', 'page'),
    );
    expect(screen.getByRole('link', { name: /Deadlines/ })).toHaveAttribute('data-active');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });
});
