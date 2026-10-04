import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtSegmentedControl } from './segmented-control';
import type { MtOption } from '../forms/options';

const VIEWS: MtOption[] = [
  { value: 'list', label: 'List', icon: 'list' },
  { value: 'board', label: 'Board', icon: 'board' },
  { value: 'timeline', label: 'Timeline', icon: 'calendar' },
];

describe('MtSegmentedControl', () => {
  @Component({
    imports: [MtSegmentedControl, ReactiveFormsModule],
    template: `<mt-segmented-control label="Matters view" [options]="views" [formControl]="view" />`,
  })
  class Host {
    readonly views = VIEWS;
    readonly view = new FormControl('list', { nonNullable: true });
  }

  it('renders a named group with the selected item marked', async () => {
    await render(Host);
    expect(screen.getByRole('group', { name: 'Matters view' })).toHaveClass('mt-seg');
    expect(screen.getByRole('radio', { name: 'List' })).toHaveAttribute('data-selected');
    expect(screen.getByRole('radio', { name: 'Board' })).not.toHaveAttribute('data-selected');
  });

  it('moves with the arrow keys, selects with Space, and never deselects', async () => {
    const { fixture } = await render(Host);
    screen.getByRole('radio', { name: 'List' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Board' })).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(fixture.componentInstance.view.value).toBe('board');

    await userEvent.click(screen.getByRole('radio', { name: 'Board' }));
    expect(fixture.componentInstance.view.value).toBe('board');
    expect(screen.getByRole('radio', { name: 'Board' })).toHaveAttribute('data-selected');
  });

  it('follows the form value', async () => {
    const { fixture } = await render(Host);
    fixture.componentInstance.view.setValue('timeline');
    await fixture.whenStable();
    expect(screen.getByRole('radio', { name: 'Timeline' })).toHaveAttribute('data-selected');
  });
});
