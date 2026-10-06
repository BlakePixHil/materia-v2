import { render, screen } from '@testing-library/angular';

import { MtSettingsRow, MtSettingsSection } from './settings-row';
import { MtSwitch } from '../switch/switch';

describe('SettingsSection and SettingsRow', () => {
  it('groups rows under a heading, with a hidden-label switch and a locked row', async () => {
    await render(
      `<mt-settings-section title="What Clerk can read" description="Only what is switched on here.">
         <mt-settings-row title="Email" description="Only emails filed to a matter.">
           <mt-switch label="Email" [labelHidden]="true" />
         </mt-settings-row>
         <mt-settings-row title="Send email" [locked]="true" />
       </mt-settings-section>`,
      { imports: [MtSettingsSection, MtSettingsRow, MtSwitch] },
    );
    expect(screen.getByRole('group', { name: 'What Clerk can read' })).toHaveTextContent(
      'Only what is switched on here.',
    );
    expect(screen.getByRole('switch', { name: 'Email' })).toBeInTheDocument();
    expect(screen.getByText('Email', { selector: '[ngplabel], .mt-sr' })).toHaveClass('mt-sr');
    expect(screen.getByRole('img', { name: 'Locked' })).toBeInTheDocument();
    expect(screen.getByText('Send email').closest('mt-settings-row')).toHaveAttribute('data-locked');
  });

  it('keeps the title off the host, so the browser shows no tooltip over the section', async () => {
    const { container } = await render(
      `<mt-settings-section title="Anthropic API key"><mt-settings-row title="Email" /></mt-settings-section>`,
      { imports: [MtSettingsSection, MtSettingsRow] },
    );
    expect(container.querySelector('mt-settings-section')).not.toHaveAttribute('title');
    expect(container.querySelector('mt-settings-row')).not.toHaveAttribute('title');
  });
});
