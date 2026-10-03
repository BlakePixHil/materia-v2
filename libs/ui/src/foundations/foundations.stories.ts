import type { Meta, StoryObj } from '@storybook/angular';
import { expect } from 'storybook/test';

import { MT_TOKENS } from '../tokens';

/** Foundations rendered from the generated token map (libs/ui/src/generated/tokens.ts). */
const meta: Meta = {
  title: 'Foundations',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

const palette = MT_TOKENS.color.filter((t) => typeof t.value === 'string');
const semantic = MT_TOKENS.color.filter((t) => typeof t.value !== 'string');
const groups = MT_TOKENS.type.groups as readonly {
  name: string;
  styles: readonly {
    name: string;
    fontSize: string;
    lineHeight: string;
    fontWeight: number;
    sample: string;
    usage: string;
  }[];
}[];

const swatches = `
  <div class="fd-grid">
    @for (t of tokens; track t.name) {
      <div class="fd-swatch">
        <div class="fd-chip" [style.background]="'var(--' + t.name + ')'"></div>
        <span class="fd-name">{{ t.name }}</span>
        <span class="fd-meta">{{ describe(t.value) }}</span>
      </div>
    }
  </div>`;

function describe(value: string | { light: string; dark: string }): string {
  return typeof value === 'string' ? value : `light ${value.light} · dark ${value.dark}`;
}

export const Colours: Story = {
  render: () => ({
    props: { semantic, palette, describe },
    template: `
      <div class="fd">
        <h2>Colours</h2>
        <section>
          <h3>Semantic (follow the theme)</h3>
          ${swatches.replace('tokens', 'semantic')}
        </section>
        <section>
          <h3>Palette (use through the semantic tokens)</h3>
          ${swatches.replace('tokens', 'palette')}
        </section>
      </div>`,
  }),
  play: async ({ canvas }) => {
    await expect(canvas.getByText('bg-canvas')).toBeTruthy();
    await expect(canvas.getAllByText(/^slate-/).length).toBeGreaterThan(10);
  },
};

export const Type: Story = {
  render: () => ({
    props: { groups, families: MT_TOKENS.type.families },
    template: `
      <div class="fd">
        <h2>Type</h2>
        @for (group of groups; track group.name) {
          <section>
            <h3>{{ group.name }}</h3>
            <div class="fd-rows">
              @for (s of group.styles; track s.name) {
                <div class="fd-row">
                  <div class="fd-swatch">
                    <span class="fd-name">{{ s.name }}</span>
                    <span class="fd-meta">{{ s.fontSize }} / {{ s.lineHeight }} · {{ s.fontWeight }}</span>
                  </div>
                  <div class="fd-swatch">
                    <span [class]="s.name">{{ s.sample }}</span>
                    <span class="fd-meta">{{ s.usage }}</span>
                  </div>
                </div>
              }
            </div>
          </section>
        }
        <section>
          <h3>Families</h3>
          <div class="fd-rows">
            <div class="fd-row"><span class="fd-name">sans</span><span class="fd-meta">{{ families['sans'] }}</span></div>
            <div class="fd-row"><span class="fd-name">mono</span><span class="fd-meta">{{ families['mono'] }}</span></div>
          </div>
        </section>
      </div>`,
  }),
  play: async ({ canvas }) => {
    await expect(canvas.getByText('display')).toBeTruthy();
  },
};

export const Spacing: Story = {
  render: () => ({
    props: { spacing: MT_TOKENS.spacing, radius: MT_TOKENS.radius, shadow: MT_TOKENS.shadow, size: MT_TOKENS.size },
    template: `
      <div class="fd">
        <h2>Spacing, radius, elevation and sizes</h2>
        <section>
          <h3>Spacing</h3>
          <div class="fd-rows">
            @for (t of spacing; track t.name) {
              <div class="fd-row">
                <span class="fd-name">{{ t.name }} · {{ t.value }}</span>
                <div class="fd-swatch"><div class="fd-bar" [style.inline-size]="'var(--' + t.name + ')'"></div><span class="fd-meta">{{ t.usage }}</span></div>
              </div>
            }
          </div>
        </section>
        <section>
          <h3>Radius</h3>
          <div class="fd-grid">
            @for (t of radius; track t.name) {
              <div class="fd-swatch"><div class="fd-box" [style.border-radius]="'var(--' + t.name + ')'"></div><span class="fd-name">{{ t.name }} · {{ t.value }}</span><span class="fd-meta">{{ t.usage }}</span></div>
            }
          </div>
        </section>
        <section>
          <h3>Elevation</h3>
          <div class="fd-grid">
            @for (t of shadow; track t.name) {
              <div class="fd-swatch"><div class="fd-box" [style.box-shadow]="'var(--' + t.name + ')'"></div><span class="fd-name">{{ t.name }}</span><span class="fd-meta">{{ t.usage }}</span></div>
            }
          </div>
        </section>
        <section>
          <h3>Sizes</h3>
          <div class="fd-rows">
            @for (t of size; track t.name) {
              <div class="fd-row"><span class="fd-name">{{ t.name }} · {{ t.value }}</span><span class="fd-meta">{{ t.usage }}</span></div>
            }
          </div>
        </section>
      </div>`,
  }),
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/space-16/)).toBeTruthy();
  },
};
