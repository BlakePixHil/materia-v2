import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import type { Meta, StoryObj } from '@storybook/angular';
import { expect, userEvent, within } from 'storybook/test';

import { MtCheckbox } from './checkbox';
import { MtStoryState } from '../../stories/story-state';
import type { MtOption } from '../forms/options';
import { MtKbd } from '../kbd/kbd';
import { MtRadioGroup } from '../radio/radio-group';
import { MtSegmentedControl } from '../segmented-control/segmented-control';
import { MtSwitch } from '../switch/switch';

/** Checkbox, Radio, Switch, SegmentedControl and Kbd, in every state. */
@Component({
  selector: 'mt-choice-states',
  imports: [MtCheckbox, MtRadioGroup, MtSwitch, MtSegmentedControl, MtKbd, MtStoryState, ReactiveFormsModule],
  template: `
    <div class="mt-row" style="gap: 48px; align-items: flex-start">
      <div class="mt-col" style="gap: 12px">
        <mt-checkbox label="Original will received" description="Held in safe custody since 2019" [formControl]="on" />
        <mt-checkbox label="Death certificate received" />
        <mt-checkbox label="All documents" [indeterminate]="true" />
        <mt-checkbox label="Grant of probate" mtStoryState="hover" target=".mt-check" />
        <mt-checkbox label="Notice published" mtStoryState="focus-visible" target=".mt-check" />
        <mt-checkbox label="Assets distributed" [formControl]="disabledOn" />
        <mt-checkbox label="Accounts approved" disabled />
      </div>
      <mt-radio-group label="Who is applying?" [options]="applicants" [formControl]="applicant" />
      <div class="mt-col" style="gap: 14px">
        <mt-switch label="Clerk suggestions on Today" [formControl]="on" />
        <mt-switch label="Capture time from email and calendar" [formControl]="on" />
        <mt-switch label="Sync deadlines to Outlook" />
        <mt-switch label="Share captured time with the billing partner" disabled />
      </div>
    </div>
    <div class="mt-row" style="gap: 24px; margin-top: 32px">
      <mt-segmented-control label="Matters view" [options]="views" [formControl]="view" />
      <mt-segmented-control label="Period" [options]="periods" [formControl]="period" />
    </div>
    <div class="mt-row mt-wrap" style="gap: 20px; margin-top: 32px">
      <span class="mt-row" style="gap: 6px"
        ><span class="body-s t-2">Command palette</span><mt-kbd keys="mod+k"
      /></span>
      <span class="mt-row" style="gap: 6px"><span class="body-s t-2">Ask Clerk</span><mt-kbd keys="mod+j" /></span>
      <span class="mt-row" style="gap: 6px"><span class="body-s t-2">New matter</span><mt-kbd keys="c" /></span>
      <span class="mt-row" style="gap: 6px"><span class="body-s t-2">Go to matters</span><mt-kbd keys="g m" /></span>
    </div>
  `,
})
class ChoiceStates {
  protected readonly on = new FormControl(true);
  protected readonly disabledOn = new FormControl({ value: true, disabled: true });
  protected readonly applicant = new FormControl('sole');
  protected readonly view = new FormControl('list');
  protected readonly period = new FormControl('month');
  protected readonly applicants: MtOption[] = [
    { value: 'sole', label: 'Sole executor', description: 'Catherine Whitfield' },
    { value: 'both', label: 'Both executors', description: 'Catherine Whitfield and Peter Hale' },
    { value: 'reserved', label: 'Executor with power reserved', description: 'Peter Hale may apply later' },
    { value: 'admin', label: 'Administrator', disabled: true },
  ];
  protected readonly views: MtOption[] = [
    { value: 'list', label: 'List', icon: 'list' },
    { value: 'board', label: 'Board', icon: 'board' },
    { value: 'timeline', label: 'Timeline', icon: 'calendar' },
  ];
  protected readonly periods: MtOption[] = [
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
    { value: 'fy', label: 'FY 2026–27' },
  ];
}

const meta: Meta<ChoiceStates> = {
  title: 'Components/Choices',
  component: ChoiceStates,
};
export default meta;
type Story = StoryObj<ChoiceStates>;

export const States: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Radio: arrow keys move the selection.
    await userEvent.click(canvas.getByRole('radio', { name: 'Sole executor' }));
    await userEvent.keyboard('{ArrowDown}');
    await expect(canvas.getByRole('radio', { name: 'Both executors' })).toHaveAttribute('aria-checked', 'true');
    // Switch: Space toggles.
    const sync = canvas.getByRole('switch', { name: 'Sync deadlines to Outlook' });
    sync.focus();
    await userEvent.keyboard(' ');
    await expect(sync).toHaveAttribute('aria-checked', 'true');
    // Checkbox: Space toggles.
    const box = canvas.getByRole('checkbox', { name: 'Death certificate received' });
    box.focus();
    await userEvent.keyboard(' ');
    await expect(box).toHaveAttribute('aria-checked', 'true');
  },
};

export const StatesDark: Story = { globals: { theme: 'dark' } };
