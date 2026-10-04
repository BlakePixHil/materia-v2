import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { House } from 'lucide';

import { MT_ICON_STROKE, MtIcon, type MtIconSize } from './icon';
import { MT_ICONS } from '../../generated/icons';

@Component({
  imports: [MtIcon],
  template: `<mt-icon [name]="name()" [size]="size()" [label]="label()" />`,
})
class Host {
  readonly name = signal<'matters' | typeof House>('matters');
  readonly size = signal<MtIconSize>(16);
  readonly label = signal<string | undefined>(undefined);
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const svg = () => fixture.nativeElement.querySelector('svg') as SVGSVGElement;
  return { fixture, svg };
}

describe('MtIcon', () => {
  it('renders a Materia icon at 16px with the brand stroke, decorative by default', async () => {
    const { svg } = await render();
    expect(svg().classList).toContain('mt-i');
    expect(svg().getAttribute('width')).toBe('16');
    expect(svg().getAttribute('stroke-width')).toBe(String(MT_ICON_STROKE));
    expect(svg().getAttribute('aria-hidden')).toBe('true');
    expect(svg().getAttribute('data-size')).toBeNull();
    expect(svg().querySelectorAll('path, rect').length).toBe(MT_ICONS.matters.length);
  });

  it('maps 14 and 20 to the sm and lg sizes', async () => {
    const { fixture, svg } = await render();
    fixture.componentInstance.size.set(14);
    await fixture.whenStable();
    expect(svg().getAttribute('data-size')).toBe('sm');
    expect(svg().getAttribute('width')).toBe('14');
    fixture.componentInstance.size.set(20);
    await fixture.whenStable();
    expect(svg().getAttribute('data-size')).toBe('lg');
  });

  it('accepts a Lucide icon node and an accessible label', async () => {
    const { fixture, svg } = await render();
    fixture.componentInstance.name.set(House);
    fixture.componentInstance.label.set('Home');
    await fixture.whenStable();
    expect(svg().getAttribute('role')).toBe('img');
    expect(svg().querySelector('title')?.textContent).toBe('Home');
    expect(svg().getAttribute('aria-hidden')).toBeNull();
    expect(svg().querySelectorAll('path').length).toBe(House.filter(([tag]) => tag === 'path').length);
  });

  it('renders every element type the design-system icons use', async () => {
    const { fixture, svg } = await render();
    for (const name of Object.keys(MT_ICONS) as (keyof typeof MT_ICONS)[]) {
      fixture.componentInstance.name.set(name as 'matters');
      await fixture.whenStable();
      expect(svg().children.length, name).toBe(MT_ICONS[name].length);
    }
  });
});
