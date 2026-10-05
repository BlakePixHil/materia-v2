import { render, screen } from '@testing-library/angular';

import { devMailUrl, MailDevPage } from './mail-page';

describe('MailDevPage (FND-20)', () => {
  it('frames the emulator’s dev mail function', async () => {
    await render(MailDevPage);
    expect(screen.getByRole('heading', { name: 'Dev mail' })).toBeTruthy();
    expect(screen.getByTitle('Captured email and push').getAttribute('src')).toBe(
      'http://127.0.0.1:5001/demo-materia/australia-southeast1/dev-mail',
    );
  });

  it('has nothing to show without the emulators', () => {
    expect(devMailUrl({ useEmulators: false, firebase: { projectId: 'materia-v2-prod' } })).toBeNull();
  });
});
