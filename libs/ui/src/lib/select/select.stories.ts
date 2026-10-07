import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import type { Meta, StoryObj } from '@storybook/angular';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { MtSelect } from './select';
import type { MtOption, MtOptionGroup } from '../forms/options';

const MATTER_TYPES: (MtOption | MtOptionGroup)[] = [
  { value: 'will', label: 'Will and enduring documents', icon: 'compose' },
  {
    label: 'Estates',
    options: [
      { value: 'probate', label: 'Probate', icon: 'scale' },
      { value: 'loa', label: 'Letters of administration', icon: 'scale' },
      { value: 'admin', label: 'Estate administration', icon: 'billing' },
    ],
  },
  {
    label: 'Disputes',
    options: [
      { value: 'fp', label: 'Family provision claim', icon: 'court' },
      { value: 'dispute', label: 'Will dispute', icon: 'court', disabled: true },
    ],
  },
];

@Component({
  selector: 'mt-select-states',
  imports: [MtSelect, ReactiveFormsModule],
  template: `
    <div class="mt-row" style="align-items: flex-start; gap: 24px">
      <div class="mt-col" style="width: 280px; gap: 16px">
        <mt-select
          label="Matter type"
          description="Sets the statutory deadlines Clerk tracks."
          [options]="types"
          [native]="false"
          [formControl]="type"
        />
        <mt-select label="Jurisdiction" [options]="jurisdictions" [native]="false" [formControl]="disabled" />
        <mt-select label="Fee arrangement" [options]="fees" [native]="false" [formControl]="invalid" />
      </div>
      <div class="mt-col" style="width: 280px; gap: 16px">
        <mt-select label="Matter type (native, below 768px)" [options]="types" [native]="true" [formControl]="type" />
      </div>
    </div>
  `,
})
class SelectStates {
  protected readonly types = MATTER_TYPES;
  protected readonly jurisdictions: MtOption[] = [
    { value: 'vic', label: 'Victoria' },
    { value: 'nsw', label: 'New South Wales' },
  ];
  protected readonly fees: MtOption[] = [
    { value: 'fixed', label: 'Fixed fee' },
    { value: 'hourly', label: 'Hourly' },
    { value: 'capped', label: 'Capped' },
  ];
  protected readonly type = new FormControl('probate');
  protected readonly disabled = new FormControl({ value: 'nsw', disabled: true });
  protected readonly invalid = new FormControl<string | null>(null, [Validators.required]);

  constructor() {
    this.invalid.markAsTouched();
  }
}

const meta: Meta<SelectStates> = {
  title: 'Components/Select',
  component: SelectStates,
};
export default meta;
type Story = StoryObj<SelectStates>;

export const States: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [trigger] = canvas.getAllByRole('combobox', { name: /Matter type/ });
    if (!trigger) throw new Error('No select trigger');
    trigger.focus();
    // Type-ahead while closed selects the first match.
    await userEvent.keyboard('w');
    await expect(trigger).toHaveTextContent('Will and enduring documents');
    // Arrow keys open the menu; Enter picks the active option.
    await userEvent.keyboard('{ArrowDown}');
    const listbox = await within(document.body).findByRole('listbox');
    await waitFor(() => expect(listbox).toBeVisible());
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(trigger).toHaveTextContent('Probate'));
  },
};

export const StatesDark: Story = { globals: { theme: 'dark' } };
