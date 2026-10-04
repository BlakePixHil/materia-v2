import { cleanUpOverlays, MATTER, openMatter, partyDoc, READONLY } from './testing';

/** The Parties tab (CORE-06). Fictional data only. */

afterEach(cleanUpOverlays);

const URL = '/matters/m-whitfield/parties';
type Page = Awaited<ReturnType<typeof openMatter>>;

/** Each role group as `Role: name (share), name`. */
const groups = (page: Page) =>
  [...page.body.querySelectorAll('mt-matter-parties section')].map((section) => {
    const role = page.text(section.querySelector('h3')).replace(/\s*\d+$/, '');
    const rows = [...section.querySelectorAll('li')].map((li) => {
      const share = li.querySelector('.caption');
      return page.text(li.querySelector('.name')) + (share ? ` (${page.text(share)})` : '');
    });
    return `${role}: ${rows.join(', ')}`;
  });

describe('parties', () => {
  it('lists the parties by role, in role order, with beneficiaries’ shares', async () => {
    const page = await openMatter(URL, {
      configure: (fs) => {
        fs.set(...partyDoc('beneficiary', 'c-bram', { share: 'One half' }));
        fs.set(...partyDoc('executor', 'c-avery'));
      },
    });
    expect(groups(page)).toEqual([
      'Client: Avery Quill',
      'Deceased: Margaret Whitfield',
      'Executor: Avery Quill',
      'Beneficiary: Bram Ostler (Share: One half)',
    ]);
  });

  it('adds a party found by search, as a beneficiary with a share', async () => {
    const page = await openMatter(URL);
    await page.click('Add party');
    await page.fill('Find a contact', 'ostler', page.dialog() ?? page.body);
    await page.stable(250);
    await page.click('Bram Ostler', page.dialog() ?? page.body);
    await page.fill('Share', 'Residue, equally', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    expect(page.calls('matters-upsertParty')).toEqual([
      {
        matterId: 'm-whitfield',
        contactId: 'c-bram',
        role: 'beneficiary',
        share: 'Residue, equally',
        requestId: expect.any(String),
      },
    ]);
    expect(page.dialog()).toBeNull();
    expect(groups(page).at(-1)).toBe('Beneficiary: Bram Ostler (Share: Residue, equally)');
  });

  it('asks for a contact first, and shows the server’s refusal in the dialog', async () => {
    const page = await openMatter(URL, {
      callables: {
        'matters-upsertParty': () => {
          throw {
            code: 'functions/invalid-argument',
            details: {
              code: 'INVALID_ARGUMENT',
              fields: { role: ['This contact already has that role on the matter'] },
            },
          };
        },
      },
    });
    await page.click('Add party');
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('Choose a contact, or create one.');
    await page.fill('Find a contact', 'avery', page.dialog() ?? page.body);
    await page.stable(250);
    await page.click('Avery Quill', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('This contact already has that role on the matter.');
  });

  it('records the date of death on the matter when adding its deceased', async () => {
    const page = await openMatter(URL, { matter: { deceased: undefined } });
    await page.click('Add party');
    await page.fill('Find a contact', 'whitfield', page.dialog() ?? page.body);
    await page.stable(250);
    await page.click('Margaret Whitfield', page.dialog() ?? page.body);
    await page.fill('Role', '2', page.dialog() ?? page.body);
    const date = page.dialog()?.querySelector<HTMLInputElement>('input[name="dateOfDeath"], mt-text-field input');
    expect(page.text(page.dialog())).toContain('Date of death');
    expect(date).not.toBeNull();
    await page.submit(page.dialog());
    expect(page.firestore.get(MATTER)?.['deceased']).toEqual({
      contactId: 'c-margaret',
      dateOfDeath: '2026-07-22',
      domicile: 'VIC',
      lastAddress: '',
    });
  });

  it('edits a party’s role, keeping its notes', async () => {
    const page = await openMatter(URL, {
      configure: (fs) => fs.set(...partyDoc('executor', 'c-bram', { notes: 'Named in the will' })),
    });
    await page.click('Edit Bram Ostler (Executor)');
    await page.fill('Role', '4', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    expect(page.calls('matters-upsertParty')[0]).toMatchObject({
      partyId: 'executor-c-bram',
      contactId: 'c-bram',
      role: 'administrator',
      notes: 'Named in the will',
    });
    expect(groups(page).map((g) => g.split(':')[0])).toEqual(['Client', 'Deceased', 'Administrator']);
  });

  it('removes a party (soft), and explains why the last client stays', async () => {
    const page = await openMatter(URL, { configure: (fs) => fs.set(...partyDoc('executor', 'c-bram')) });
    await page.click('Remove Bram Ostler (Executor)');
    await page.click('Remove', page.dialog() ?? page.body);
    expect(page.calls('matters-removeParty')[0]).toMatchObject({ partyId: 'executor-c-bram' });
    expect(groups(page).map((g) => g.split(':')[0])).toEqual(['Client', 'Deceased']);

    await page.click('Remove Avery Quill (Client)');
    await page.click('Remove', page.dialog() ?? page.body);
    expect(page.text()).toContain('A matter needs at least one client. Add another client before removing this one.');
  });

  it('read-only members see the parties without changing them; p opens Add party', async () => {
    const readonly = await openMatter(URL, { session: READONLY });
    expect(groups(readonly)).toHaveLength(2);
    expect(readonly.buttons('Add party')).toHaveLength(0);
    expect(readonly.buttons('Remove Avery Quill (Client)')).toHaveLength(0);
  });

  it('opens Add party with p from another tab', async () => {
    const page = await openMatter();
    await page.press('p');
    expect(page.router.url).toBe(URL);
    expect(page.text(page.dialog())).toContain('Add a party');
  });
});
