import { render, screen } from '@testing-library/angular';

import { MtSkeleton } from './skeleton';

describe('Skeleton', () => {
  it('announces what is loading and hides the bars from screen readers', async () => {
    const { container } = await render(`<mt-skeleton label="Loading matters…" framed />`, {
      imports: [MtSkeleton],
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading matters…');
    expect(status).toHaveAttribute('data-framed');
    expect(status).not.toHaveAttribute('data-variant');
    const rows = container.querySelectorAll('.row');
    expect(rows).toHaveLength(4);
    rows.forEach((row) => expect(row).toHaveAttribute('aria-hidden', 'true'));
  });

  it('draws the requested number of cards, lines or fields', async () => {
    const { container } = await render(
      `<mt-skeleton id="cards" variant="cards" [count]="5" />
       <mt-skeleton id="lines" variant="lines" [count]="2" />
       <mt-skeleton id="fields" variant="fields" />`,
      { imports: [MtSkeleton] },
    );
    expect(container.querySelector('#cards')).toHaveAttribute('data-variant', 'cards');
    expect(container.querySelectorAll('#cards > .card')).toHaveLength(5);
    expect(container.querySelectorAll('#lines > .mt-skel')).toHaveLength(2);
    expect(container.querySelectorAll('#fields > .row > .tx')).toHaveLength(3);
  });
});
