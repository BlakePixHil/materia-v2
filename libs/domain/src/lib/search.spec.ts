import { contactSearchTokens } from './contacts';
import { matterSearchTokens } from './matters';
import {
  compactText,
  documentSearchTokens,
  isExactNumberMatch,
  matchesSearch,
  normaliseText,
  numberTokens,
  parseSearchQuery,
  rankSearchHits,
  SEARCH_TOKENS_LIMIT,
  searchRank,
  searchTokens,
  searchTokensWithNumber,
  taskSearchTokens,
} from './search';

describe('the tokeniser', () => {
  it('NFKD-normalises, strips diacritics and lower-cases', () => {
    expect(normaliseText('Ｍ－２０２６')).toBe('m 2026'); // full-width forms fold to ASCII under NFKD
    expect(normaliseText('Zoë Ångström-Ñúñez')).toBe('zoe angstrom nunez');
    expect(normaliseText('ﬁnancial')).toBe('financial'); // the "fi" ligature
    expect(compactText('M-2026-0142')).toBe('m20260142');
  });

  it('emits prefixes of 2 to 10 per word and stops at 60 tokens', () => {
    expect(searchTokens('Doyle')).toEqual(['do', 'doy', 'doyl', 'doyle']);
    const long = searchTokens(
      'alphabetical bystanders catastrophe dangerously enthusiasm fragmented gregarious hypothetical',
    );
    expect(long).toHaveLength(SEARCH_TOKENS_LIMIT);
    expect(long[0]).toBe('al');
  });

  it('keeps a matter number whole, digits only, in parts and without leading zeros', () => {
    const tokens = numberTokens('M-2026-0142');
    expect(tokens.slice(0, 2)).toEqual(['m20260142', '20260142']);
    expect(tokens).toEqual(expect.arrayContaining(['m2026', '2026', '0142', '142', '14', '2026014']));
    expect(tokens.every((token) => token.length >= 2)).toBe(true);
    // Numbers longer than 10 keep their whole form as well as the 10-character prefixes.
    expect(numberTokens('HV/2026/000142')).toEqual(expect.arrayContaining(['hv2026000142', 'hv20260001', '142']));
    expect(numberTokens('')).toEqual([]);
  });

  it('never cuts the number when the texts fill the cap', () => {
    const tokens = searchTokensWithNumber('M-2026-0142', 'a b '.repeat(10), 'alphabetical bystanders '.repeat(10));
    expect(tokens.length).toBeLessThanOrEqual(SEARCH_TOKENS_LIMIT);
    expect(tokens).toEqual(expect.arrayContaining(numberTokens('M-2026-0142')));
  });

  it('tokenises tasks by title and documents by name', () => {
    expect(taskSearchTokens('Lodge the Inventory of Assets')).toEqual(expect.arrayContaining(['lodge', 'inventory']));
    expect(documentSearchTokens('Grant of probate – Doyle.pdf')).toEqual(
      expect.arrayContaining(['grant', 'probate', 'doyle', 'pdf']),
    );
    expect(taskSearchTokens(undefined)).toEqual([]);
  });
});

describe('parsing a query', () => {
  it.each([
    ['142', '142', '142'],
    ['M-2026-0142', 'm20260142', 'm20260142'],
    ['2026-0142', '20260142', '20260142'],
    ['HV/2026/000142', 'hv2026000142', 'hv20260001'],
    ['estate of whitfield', null, 'whitfield'],
    ['Nguyễn', null, 'nguyen'],
    ['  o', null, null],
  ])('%s', (typed, number, token) => {
    const query = parseSearchQuery(typed);
    expect(query.number).toBe(number);
    expect(query.token).toBe(token);
  });

  it('takes the first of the longest words', () => {
    expect(parseSearchQuery('ruth elli').token).toBe('ruth');
    expect(parseSearchQuery('of the doyle trust').token).toBe('doyle');
  });
});

describe('matching and ranking', () => {
  const tokens = matterSearchTokens({
    number: 'M-2026-0142',
    title: 'Estate of Margaret Whitfield',
    clientNames: ['Catherine Whitfield'],
  });

  it('matches every word typed, a number in any form, and long words against the texts', () => {
    expect(matchesSearch(tokens, parseSearchQuery('whitf cath'))).toBe(true);
    expect(matchesSearch(tokens, parseSearchQuery('whitfield doyle'))).toBe(false);
    for (const typed of ['142', '0142', '2026-0142', 'M-2026-0142', 'm2026']) {
      expect(matchesSearch(tokens, parseSearchQuery(typed)), typed).toBe(true);
    }
    expect(matchesSearch(tokens, parseSearchQuery('143'))).toBe(false);
    const long = searchTokens('Featherstonehaugh');
    expect(matchesSearch(long, parseSearchQuery('featherstonehaugh'), ['Featherstonehaugh'])).toBe(true);
    expect(matchesSearch(long, parseSearchQuery('featherstonehaxx'), ['Featherstonehaugh'])).toBe(false);
    expect(matchesSearch(tokens, parseSearchQuery('x'))).toBe(false);
  });

  it('ranks an exact number, then a title prefix, then recency', () => {
    const query = parseSearchQuery('142');
    expect(isExactNumberMatch('M-2026-0142', query)).toBe(true);
    expect(isExactNumberMatch('M-2026-1420', query)).toBe(false);
    expect(searchRank({ title: 'Estate', number: 'M-2026-0142' }, query)).toBe(0);
    const hits = [
      { id: 'old', title: 'Estate of Lena Whitfield', at: new Date('2026-01-01') },
      { id: 'other', title: 'Alice Whitfield — power of attorney', at: new Date('2026-09-01') },
      { id: 'new', title: 'Estate of Margaret Whitfield', at: new Date('2026-06-01') },
      { id: 'exact', title: 'Will of Ann Whitfield', number: 'ES-2026-0001', at: null },
    ];
    expect(rankSearchHits(hits, parseSearchQuery('estate')).map((h) => h.id)).toEqual(['new', 'old', 'other', 'exact']);
    expect(rankSearchHits(hits, parseSearchQuery('ES-2026-0001'))[0]?.id).toBe('exact');
  });
});

/**
 * The seeded search table (CORE-15 acceptance): twenty queries over fictional matters, contacts,
 * tasks and documents. Each query reads the documents whose tokens hold the query's token (what
 * `array-contains` returns), keeps those matching every word, ranks them and expects the top hit.
 */
describe('seeded searches', () => {
  interface Doc {
    id: string;
    title: string;
    number?: string;
    at: Date;
    tokens: string[];
    texts: string[];
  }
  const at = (day: number) => new Date(Date.UTC(2026, 8, day));
  const matter = (id: string, number: string, title: string, day: number, clients: string[], deceased?: string) => ({
    id,
    title,
    number,
    at: at(day),
    tokens: matterSearchTokens({
      number,
      title,
      clientNames: clients,
      ...(deceased ? { deceasedName: deceased } : {}),
    }),
    texts: [number, title, ...clients, ...(deceased ? [deceased] : [])],
  });
  const contact = (id: string, givenNames: string, familyName: string, day: number) => ({
    id,
    title: `${givenNames} ${familyName}`,
    at: at(day),
    tokens: contactSearchTokens({ givenNames, familyName }),
    texts: [givenNames, familyName],
  });
  const task = (id: string, title: string, day: number) => ({
    id,
    title,
    at: at(day),
    tokens: taskSearchTokens(title),
    texts: [title],
  });
  const document = (id: string, name: string, day: number) => ({
    id,
    title: name,
    at: at(day),
    tokens: documentSearchTokens(name),
    texts: [name],
  });

  const DOCS: Doc[] = [
    matter('m-doyle', 'M-2026-0142', 'Estate of Margaret Doyle', 20, ['Catherine Doyle'], 'Margaret Doyle'),
    matter('m-nguyen', 'M-2026-0143', 'Nguyễn v Nguyễn', 18, ['Thi Mai Nguyễn']),
    matter('m-brennan', 'M-2025-0099', 'Doyle v Brennan', 10, ['Thomas Doyle']),
    matter('m-okafor', 'M-2026-0151', 'Harriet and Paul Okafor', 22, ['Harriet Okafor', 'Paul Okafor']),
    matter(
      'm-feather',
      'M-2026-0160',
      'Estate of Desmond Featherstonehaugh',
      5,
      ['Zoë Ångström'],
      'Desmond Featherstonehaugh',
    ),
    matter('m-ellis', 'M-2024-0007', 'Ellis Testamentary Trust', 2, ['Ruth Ellis']),
    contact('c-catherine', 'Catherine', 'Doyle', 12),
    contact('c-obrien', 'Patrick', "O'Brien", 14),
    contact('c-zoe', 'Zoë', 'Ångström', 9),
    task('t-certificate', 'Obtain death certificate', 21),
    task('t-inventory', 'Lodge the Inventory of Assets and Liabilities', 19),
    task('t-notice', 'Publish notice of intended application', 7),
    document('d-will', 'Will of Margaret Doyle (fictional).pdf', 16),
    document('d-grant', 'Grant of probate – Nguyễn.pdf', 11),
    document('d-valuation', 'Property valuation 12 Example St.pdf', 3),
  ];

  function search(typed: string): string[] {
    const query = parseSearchQuery(typed);
    if (!query.token) return [];
    const candidates = DOCS.filter((doc) => doc.tokens.includes(query.token as string));
    return rankSearchHits(
      candidates.filter((doc) => matchesSearch(doc.tokens, query, doc.texts)),
      query,
    ).map((doc) => doc.id);
  }

  it.each([
    ['142', 'm-doyle'],
    ['M-2026-0142', 'm-doyle'],
    ['2026-0142', 'm-doyle'],
    ['m-2026-0143', 'm-nguyen'],
    ['0007', 'm-ellis'],
    ['doyle', 'm-brennan'],
    ['estate of margaret', 'm-doyle'],
    ['nguyen', 'm-nguyen'],
    ['Nguyễn grant', 'd-grant'],
    ['harriet okafor', 'm-okafor'],
    ['zoe', 'c-zoe'],
    ['ångström', 'c-zoe'],
    ['obrien', 'c-obrien'],
    ["o'brien", 'c-obrien'],
    ['featherstonehaugh', 'm-feather'],
    ['death cert', 't-certificate'],
    ['inventory', 't-inventory'],
    ['notice application', 't-notice'],
    ['will doyle', 'd-will'],
    ['valuation pdf', 'd-valuation'],
  ])('“%s” finds %s first', (typed, expected) => {
    expect(search(typed)[0]).toBe(expected);
  });

  it('finds every Doyle (matters by client, contacts, documents), the title match first', () => {
    expect(search('doyle')).toEqual(['m-brennan', 'm-doyle', 'd-will', 'c-catherine']);
  });
});
