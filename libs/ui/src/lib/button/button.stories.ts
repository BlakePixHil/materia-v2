import { Component } from '@angular/core';
import type { Meta, StoryObj } from '@storybook/angular';
import { expect, fn, userEvent, within } from 'storybook/test';

import { MtButton, type MtButtonVariant } from './button';
import { MtStoryState, STATE_GRID_STYLES } from '../../stories/story-state';
import { MtIconButton } from '../icon-button/icon-button';

@Component({
  selector: 'mt-button-states',
  imports: [MtButton, MtIconButton, MtStoryState],
  styles: [STATE_GRID_STYLES],
  template: `
    <div class="sg" style="grid-template-columns: auto repeat(5, max-content)">
      <span></span>
      @for (state of states; track state) {
        <span class="sg-h">{{ state }}</span>
      }
      @for (row of variants; track row.variant) {
        <span class="sg-h">{{ row.variant }}</span>
        <button mtButton [variant]="row.variant" [iconStart]="row.icon">{{ row.label }}</button>
        <button mtButton [variant]="row.variant" [iconStart]="row.icon" mtStoryState="hover">{{ row.label }}</button>
        <button mtButton [variant]="row.variant" [iconStart]="row.icon" mtStoryState="focus-visible">
          {{ row.label }}
        </button>
        <button mtButton [variant]="row.variant" [iconStart]="row.icon" disabled>{{ row.label }}</button>
        <button mtButton [variant]="row.variant" [iconStart]="row.icon" loading>{{ row.label }}</button>
      }
    </div>
    <div class="mt-row mt-wrap" style="margin-top: 24px">
      <button mtButton variant="primary" size="sm" iconStart="plus">New matter</button>
      <button mtButton variant="primary" iconStart="plus" kbd="c">New matter</button>
      <button mtButton variant="primary" size="lg" iconStart="plus">New matter</button>
      <button mtButton size="sm" iconStart="filter">Filter</button>
      <button mtButton iconEnd="chevron-down">Export</button>
      <button mtButton loading>Saving</button>
      <a mtButton variant="ghost" href="#matters">All matters</a>
    </div>
    <div class="mt-row" style="margin-top: 24px">
      @for (variant of iconVariants; track variant) {
        <button mtIconButton icon="more" label="More actions" [variant]="variant"></button>
        <button mtIconButton icon="more" label="More actions" [variant]="variant" mtStoryState="hover"></button>
        <button mtIconButton icon="more" label="More actions" [variant]="variant" mtStoryState="focus-visible"></button>
        <button mtIconButton icon="more" label="More actions" [variant]="variant" disabled></button>
        <button mtIconButton icon="more" label="More actions" [variant]="variant" size="sm"></button>
      }
    </div>
  `,
})
class ButtonStates {
  protected readonly states = ['rest', 'hover', 'focus', 'disabled', 'loading'];
  protected readonly variants: { variant: MtButtonVariant; label: string; icon: string }[] = [
    { variant: 'primary', label: 'Publish notice', icon: 'scale' },
    { variant: 'secondary', label: 'Record time', icon: 'timer' },
    { variant: 'ghost', label: 'Edit', icon: 'compose' },
    { variant: 'danger', label: 'Delete matter', icon: 'trash' },
    { variant: 'clerk', label: 'Ask Clerk', icon: 'sparkle' },
  ];
  protected readonly iconVariants = ['ghost', 'secondary', 'clerk'] as const;
}

const meta: Meta<MtButton> = {
  title: 'Components/Button',
  component: MtButton,
  render: (args) => ({
    props: { ...args, clicked: fn() },
    template: `<button mtButton [variant]="variant" [size]="size" [loading]="loading" [iconStart]="iconStart" [kbd]="kbd" (click)="clicked()">Record time</button>`,
  }),
  args: { variant: 'primary', size: 'md', loading: false, iconStart: 'timer', kbd: 't' },
  argTypes: {
    variant: { control: 'select', options: ['primary', 'secondary', 'ghost', 'danger', 'clerk'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
  },
};
export default meta;
type Story = StoryObj<MtButton>;

export const Playground: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: /Record time/ });
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await expect(button).toHaveAttribute('data-focus-visible');
    await userEvent.keyboard('{Enter}');
  },
};

export const States: Story = {
  render: () => ({ moduleMetadata: { imports: [ButtonStates] }, template: '<mt-button-states />' }),
};

export const StatesDark: Story = { ...States, globals: { theme: 'dark' } };
