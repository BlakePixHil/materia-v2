import type { Meta, StoryObj } from '@storybook/angular';
import { expect } from 'storybook/test';

import { Ui } from './ui';

/** Sample story proving Storybook works. FND-07 onwards replaces it with real components. */
const meta: Meta<Ui> = {
  component: Ui,
  title: 'Setup/Placeholder',
};
export default meta;

type Story = StoryObj<Ui>;

export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Ui works!')).toBeTruthy();
  },
};
