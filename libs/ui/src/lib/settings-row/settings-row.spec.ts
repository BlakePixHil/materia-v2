import { render, screen } from '@testing-library/angular';

import { MtSettingsRow, MtSettingsSection } from './settings-row';
import { MtSelect } from '../select/select';
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

  it('puts lead content before the title and hides a select’s label, keeping its name', async () => {
    const { container } = await render(
      `<mt-settings-section title="Members">
         <mt-settings-row title="Sam Lee">
           <span mtRowLead data-lead>SL</span>
           <mt-select label="Role for Sam Lee" labelHidden size="sm" [native]="true" [options]="options" />
         </mt-settings-row>
       </mt-settings-section>`,
      {
        imports: [MtSettingsSection, MtSettingsRow, MtSelect],
        componentProperties: { options: [{ value: 'lawyer', label: 'Lawyer' }] },
      },
    );
    const row = container.querySelector('mt-settings-row');
    expect(row?.firstElementChild).toHaveAttribute('data-lead');
    expect(screen.getByRole('combobox', { name: 'Role for Sam Lee' })).toBeInTheDocument();
    expect(screen.getByText('Role for Sam Lee')).toHaveClass('mt-sr');
    expect(row?.querySelector('.mt-input')).toHaveAttribute('data-size', 'sm');
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
