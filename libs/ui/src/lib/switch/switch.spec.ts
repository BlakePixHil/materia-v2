import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtSwitch } from './switch';

describe('MtSwitch', () => {
  @Component({
    imports: [MtSwitch, ReactiveFormsModule],
    template: `<mt-switch
      label="Clerk suggestions on Today"
      description="Shows proposals from Clerk on your Today screen."
      [formControl]="enabled"
    />`,
  })
  class Host {
    readonly enabled = new FormControl(true, { nonNullable: true });
  }

  it('is a labelled switch reflecting the form value', async () => {
    await render(Host);
    const toggle = screen.getByRole('switch', { name: 'Clerk suggestions on Today' });
    expect(toggle).toHaveClass('mt-switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAttribute('data-checked');
    expect(toggle).toHaveAccessibleDescription('Shows proposals from Clerk on your Today screen.');
  });

  it('toggles with Space and Enter', async () => {
    const { fixture } = await render(Host);
    screen.getByRole('switch').focus();
    await userEvent.keyboard(' ');
    expect(fixture.componentInstance.enabled.value).toBe(false);
    await userEvent.keyboard('{Enter}');
    expect(fixture.componentInstance.enabled.value).toBe(true);
  });

  it('renders data-disabled when the form control is disabled', async () => {
    const { fixture } = await render(Host);
    fixture.componentInstance.enabled.disable();
    await fixture.whenStable();
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('data-disabled');
    await userEvent.click(toggle);
    expect(fixture.componentInstance.enabled.value).toBe(true);
  });
});
