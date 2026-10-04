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

  it('renders integration cards with status and an initial logo', async () => {
    await render(
      `<mt-integration-card name="outlook" description="Email filing" status="connected" />
       <mt-integration-card name="Registry" status="error" />
       <mt-integration-card name="Xero" />`,
      { imports: [MtIntegrationCard] },
    );
    expect(screen.getByText('O')).toHaveClass('logo');
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
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
