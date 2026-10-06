import { render, screen } from '@testing-library/angular';

import { MtPersonHeader } from './person-header';
import { MtEmptyState } from '../empty-state/empty-state';
import { MtIntegrationCard } from '../integration-card/integration-card';
import { MtBadge } from '../markers/markers';
import { MtNote } from '../note/note';

describe('PersonHeader, IntegrationCard, Note and EmptyState', () => {
  it('renders a person header with badges and roles', async () => {
    await render(
      `<mt-person-header name="Catherine Whitfield" subtitle="Mosman NSW" [roles]="roles"><mt-badge tone="success">ID verified</mt-badge></mt-person-header>`,
      {
        imports: [MtPersonHeader, MtBadge],
        componentProperties: { roles: [{ label: 'Executor', ref: 'WE-142' }, { label: 'Will client' }] },
      },
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Catherine Whitfield' })).toBeInTheDocument();
    expect(screen.getByText('ID verified')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Roles' })).toHaveTextContent('Executor WE-142');
  });

  it('renders integration cards in each state, with an initial logo', async () => {
    const reason =
      'Xero refused the connection: the organisation’s subscription has lapsed. Reconnect with a Xero user who has the Standard role or above.';
    const { container } = await render(
      `<mt-integration-card name="outlook" description="Email filing" status="connected" meta="Connected as Fictional Legal" />
       <mt-integration-card name="Google Workspace" status="reconnect" meta="Signed out on 3 Oct" />
       <mt-integration-card name="Xero" status="error" [error]="reason" />
       <mt-integration-card name="Inbound email" />
       <mt-integration-card name="RedCrest" status="unavailable" />`,
      { imports: [MtIntegrationCard], componentProperties: { reason } },
    );
    expect(screen.getByText('O')).toHaveClass('logo');
    const badges = [...container.querySelectorAll('mt-badge')].map((badge) => [
      badge.textContent?.trim(),
      badge.getAttribute('data-tone'),
    ]);
    expect(badges).toEqual([
      ['Connected', 'success'],
      ['Reconnect needed', 'warning'],
      ['Error', 'danger'],
      ['Not available yet', null],
    ]);
    expect(screen.getByText('Connected as Fictional Legal')).toHaveClass('caption');
    // The reason is announced and shown in full; only the error state marks the card.
    expect(screen.getByRole('alert')).toHaveTextContent(reason);
    expect(container.querySelectorAll('mt-integration-card[data-state="error"]')).toHaveLength(1);
  });

  it('renders notes by tone and an empty state', async () => {
    const { container } = await render(
      `<mt-note>Info</mt-note><mt-note tone="warning">Careful</mt-note><mt-note tone="danger" icon="flag">Stop</mt-note>
       <mt-empty-state title="No deadlines this week" description="They appear when a matter is set up." icon="calendar" [headingLevel]="2"><button type="button">Add</button></mt-empty-state>
       <mt-empty-state title="Nothing here" />`,
      { imports: [MtNote, MtEmptyState] },
    );
    expect(screen.getAllByRole('note')).toHaveLength(2);
    expect(screen.getByRole('alert')).toHaveTextContent('Stop');
    expect(container.querySelector('mt-note[data-tone="warning"]')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'No deadlines this week' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Nothing here' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });
});
