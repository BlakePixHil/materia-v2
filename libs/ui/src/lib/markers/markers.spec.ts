import { render, screen } from '@testing-library/angular';

import {
  avatarHue,
  initialsOf,
  MtAvatar,
  MtAvatarGroup,
  MtBadge,
  MtMatterTag,
  MtPriorityIcon,
  MtStatusIcon,
} from './markers';

describe('markers', () => {
  it('takes up to two initials', () => {
    expect(initialsOf('Catherine Whitfield')).toBe('CW');
    expect(initialsOf('  priya  ')).toBe('P');
    expect(initialsOf('Harriet Anne Okafor')).toBe('HO');
    expect(initialsOf('')).toBe('?');
  });

  it('gives a stable hue from 1 to 4', () => {
    expect(avatarHue('u1')).toBe(avatarHue('u1'));
    const hues = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(avatarHue));
    expect([...hues].every((h) => h >= 1 && h <= 4)).toBe(true);
    expect(hues.size).toBeGreaterThan(1);
  });

  it('renders an avatar with initials, falls back from a broken image, and supports kinds', async () => {
    const { container, rerender } = await render(MtAvatar, {
      inputs: { name: 'Jordan Price', src: 'https://example.invalid/a.png', hue: 'risk' },
    });
    expect(screen.getByRole('img', { name: 'Jordan Price' })).toHaveAttribute('data-hue', 'risk');
    const img = container.querySelector('img') as HTMLImageElement;
    img.dispatchEvent(new Event('error'));
    await rerender({ partialUpdate: true });
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('JP');
  });

  it('renders the Clerk avatar', async () => {
    const { container } = await render(MtAvatar, { inputs: { name: 'Clerk', kind: 'clerk', size: 'lg' } });
    expect(container).toHaveAttribute('data-kind', 'clerk');
    expect(container).toHaveAttribute('data-size', 'lg');
    expect(container).not.toHaveTextContent('C');
  });

  it('collapses extra people into +N', async () => {
    const people = ['Ann Lee', 'Ben Ng', 'Cat Wu', 'Dan Ito', 'Eve Ma'].map((name, i) => ({ name, id: `u${i}` }));
    await render(MtAvatarGroup, { inputs: { people, max: 3 } });
    expect(screen.getByRole('group')).toHaveAccessibleName('Ann Lee, Ben Ng, Cat Wu, Dan Ito, Eve Ma');
    expect(screen.getByRole('img', { name: '2 more' })).toHaveTextContent('+2');
  });

  it('renders badges, matter tags, status and priority icons with labels', async () => {
    const { container } = await render(
      `<mt-badge tone="ai">Drafted</mt-badge>
       <mt-matter-tag type="fp" />
       @for (status of statuses; track status) { <mt-status-icon [status]="status" /> }
       <mt-status-icon status="active" label="Notice period" />
       <mt-priority-icon level="urgent" />`,
      {
        imports: [MtBadge, MtMatterTag, MtStatusIcon, MtPriorityIcon],
        componentProperties: { statuses: ['draft', 'active', 'review', 'done', 'blocked'] },
      },
    );
    expect(container.querySelector('mt-badge')).toHaveAttribute('data-tone', 'ai');
    expect(screen.getByText('Family provision')).toHaveAttribute('data-type', 'fp');
    for (const status of ['draft', 'active', 'review', 'done', 'blocked']) {
      expect(screen.getByRole('img', { name: status })).toHaveAttribute('data-status', status);
    }
    expect(screen.getByRole('img', { name: 'Notice period' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Urgent priority' })).toHaveAttribute('data-level', 'urgent');
  });
});
