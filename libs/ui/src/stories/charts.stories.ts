import { type Meta, moduleMetadata, type StoryObj } from '@storybook/angular';
import { expect, userEvent, within } from 'storybook/test';

import { MtBarChart } from '../lib/charts/bar-chart';
import { MtLineChart } from '../lib/charts/line-chart';
import { type ChartDatum, compactNumber } from '../lib/charts/scales';

/** Fictional figures, as in the design system. */
const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const YEARS = [2025, 2025, 2025, 2026, 2026, 2026, 2026, 2026, 2026, 2026, 2026, 2026];
const BILLED: ChartDatum[] = [
  41_200, 47_800, 39_500, 28_100, 44_600, 55_300, 46_900, 58_200, 63_400, 51_700, 49_300, 46_000,
].map((value, i) => ({
  label: MONTHS[i] ?? '',
  value,
  meta: `${MONTHS[i]} ${YEARS[i]}`,
}));
const DAYS: ChartDatum[] = [52, 49, 55, 58, 47, 45, 44, 46, 43, 42, 40, 41].map((value, i) => ({
  label: MONTHS[i] ?? '',
  value,
  meta: `${MONTHS[i]} ${YEARS[i]}`,
}));
const DAYS_LAST_YEAR: ChartDatum[] = [61, 60, 63, 64, 59, 57, 55, 56, 54, 53, 52, 52].map((value, i) => ({
  label: MONTHS[i] ?? '',
  value,
}));
const WIP: ChartDatum[] = [
  'Estate of Margaret Whitfield',
  'Nguyen v Nguyen',
  'Harriet and Paul Okafor',
  'Estate of Desmond Albert Featherstonehaugh-Whittington',
  'Estate of Ruth Ellis',
].map((label, i) => ({ label, value: [4860, 18_920, 2200, 9400, -1250][i] ?? 0 }));
const MANY: ChartDatum[] = Array.from({ length: 30 }, (_, i) => ({
  label: `WE-${140 + i}`,
  value: ((i * 7919) % 20_000) + 500,
}));

const money = (value: number) => `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-AU')}`;
const moneyTick = (value: number) => (value === 0 ? '$0' : `${value < 0 ? '-' : ''}$${compactNumber(Math.abs(value))}`);
const days = (value: number) => `${value} days`;

const meta: Meta = {
  title: 'Components/Charts',
  decorators: [moduleMetadata({ imports: [MtBarChart, MtLineChart] })],
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj;

export const BarChart: Story = {
  render: () => ({
    props: { data: BILLED, money, moneyTick },
    template: `
      <div class="mt-col" style="gap: 10px; max-width: 760px">
        <div class="mt-legend"><span><i class="key-bar"></i>Billed</span><span><i class="key-line"></i>Monthly target</span></div>
        <mt-bar-chart
          label="Billed by month"
          categoryLabel="Month"
          valueLabel="Billed"
          [data]="data"
          [format]="money"
          [tickFormat]="moneyTick"
          [target]="{ value: 52000, label: 'Target $52k' }"
          [labelPoints]="[8, 11]"
        />
      </div>
    `,
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const first = canvasElement.querySelector<SVGElement>('[data-point="0"]') as SVGElement;
    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(canvasElement.querySelector('[data-point="1"]')).toHaveFocus();
    await expect(within(document.body).getByRole('tooltip')).toHaveTextContent('$47,800');
    await userEvent.click(canvas.getByText('View as table'));
    await expect(canvas.getByRole('table')).toBeVisible();
  },
};
export const BarChartDark: Story = { ...BarChart, globals: { theme: 'dark' } };

export const BarChartStates: Story = {
  render: () => ({
    props: {
      wip: WIP,
      many: MANY,
      zeros: BILLED.map((d) => ({ ...d, value: 0 })),
      one: BILLED.slice(0, 1),
      money,
      moneyTick,
    },
    template: `
      <div class="mt-col" style="gap: 32px; max-width: 760px">
        <mt-bar-chart label="WIP by matter (credits below zero)" orientation="horizontal" categoryLabel="Matter" valueLabel="WIP" [data]="wip" [format]="money" [tickFormat]="moneyTick" [highlight]="1" />
        <mt-bar-chart label="WIP across 30 matters" categoryLabel="Matter" valueLabel="WIP" [data]="many" [format]="money" [tickFormat]="moneyTick" />
        <mt-bar-chart label="Billed (all zero)" [data]="zeros" [format]="money" [tickFormat]="moneyTick" />
        <mt-bar-chart label="Billed (one month)" [data]="one" [format]="money" [tickFormat]="moneyTick" [labelPoints]="[0]" />
        <mt-bar-chart label="Billed" [data]="[]" />
        <mt-bar-chart label="Billed" [data]="one" [loading]="true" />
      </div>
    `,
  }),
};
export const BarChartStatesDark: Story = { ...BarChartStates, globals: { theme: 'dark' } };

export const LineChart: Story = {
  render: () => ({
    props: { data: DAYS, comparison: DAYS_LAST_YEAR, days, plain: (v: number) => String(v) },
    template: `
      <div class="mt-col" style="gap: 32px; max-width: 640px">
        <mt-line-chart
          label="Median days to grant"
          categoryLabel="Month"
          valueLabel="Median days to grant"
          [data]="data"
          [format]="days"
          [tickFormat]="plain"
          [reference]="{ value: 38, label: 'NSW registry median 38' }"
        />
        <div class="mt-legend"><span><i class="key-bar"></i>This year</span><span><i class="key-line"></i>Last year</span></div>
        <mt-line-chart label="Median days to grant, with last year" comparisonLabel="Last year" [data]="data" [comparison]="comparison" [format]="days" />
        <mt-line-chart label="Days to grant (one month)" [data]="data.slice(0, 1)" [format]="days" />
        <mt-line-chart label="Days to grant" [data]="[]" />
      </div>
    `,
  }),
  play: async ({ canvasElement }) => {
    const point = canvasElement.querySelector<SVGElement>('[data-point="0"]') as SVGElement;
    point.focus();
    await userEvent.keyboard('{End}');
    await expect(canvasElement.querySelector('[data-point="11"]')).toHaveFocus();
    await expect(within(document.body).getByRole('tooltip')).toHaveTextContent('41 days');
  },
};
export const LineChartDark: Story = { ...LineChart, globals: { theme: 'dark' } };
