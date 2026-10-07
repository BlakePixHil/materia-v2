import type { Tour } from './tour-model';

/**
 * The tours (CORE-24). Plain words and the practice's own kind of work: Victorian wills and
 * estates. To add a page: put `data-tour="…"` on its features and add a tour here with a `match`
 * for its path. The most specific match wins: tours are tried in order, so put sub-pages first.
 */
export const WELCOME_TOUR: Tour = {
  id: 'welcome',
  title: 'Welcome',
  intro: true,
  steps: [
    {
      title: 'Let’s show you around',
      body: 'A one-minute tour of where things live: your day, your matters, the timer and Clerk. You can take it again any time from Settings.',
    },
    {
      target: ['[data-tour="nav"]', '[data-tour="tabbar"]'],
      title: 'Your pages',
      body: 'Today is your day at a glance and Matters holds every file, from a simple will to a contested estate. Deadlines, contacts, time and billing are a click away.',
    },
    {
      target: '[data-tour="search"]',
      title: 'Find anything, do anything',
      body: 'Search for a matter number, a client’s surname or a document. It runs commands too: type “log time” or “tour” and press Enter.',
      kbd: 'mod+k',
    },
    {
      target: '[data-tour="timer"]',
      title: 'The timer',
      body: 'Start it when you pick up a file and it records to that matter in six-minute units. It keeps running as you move around, and checks with you if it’s left on overnight.',
      kbd: 'shift+t',
    },
    {
      target: '[data-tour="clerk"]',
      title: 'Ask Clerk',
      body: 'Clerk, the AI assistant, reads the matter you’re on and suggests tasks, deadlines and drafts. Nothing changes until you accept a suggestion.',
      kbd: 'mod+j',
    },
    {
      target: '[data-tour="account"]',
      title: 'Settings and your account',
      body: 'Your profile, notifications and these tours live in Settings. Press ? to see every keyboard shortcut.',
    },
    {
      title: 'That’s the tour',
      body: 'Each main page has its own short tour the first time you open it. Start one whenever you like from search (“Tour this page”) or with this shortcut.',
      kbd: 'shift+h',
    },
  ],
};

export const PAGE_TOURS: readonly Tour[] = [
  {
    id: 'today',
    title: 'Today',
    match: /^\/today$/,
    steps: [
      {
        target: '[data-tour="today-head"]',
        title: 'Your day',
        body: 'Today gathers what needs you across every matter you’re responsible for. Dates follow the practice’s time zone.',
      },
      {
        target: '[data-section="attention"]',
        title: 'Needs your attention',
        body: 'Overdue tasks and deadlines, and anything waiting on you. Clear this first.',
      },
      {
        target: '[data-section="due"]',
        title: 'Due soon',
        body: 'The week ahead, day by day: an application for a grant of probate, a notice to creditors expiring, a client signing in Geelong. Select one to open its matter.',
      },
      {
        target: '[data-section="tasks"]',
        title: 'Your tasks',
        body: 'Tasks assigned to you on any matter. Tick one off when it’s done; J and K move through the list.',
      },
      {
        target: '[data-section="recent"]',
        title: 'Pick up where you left off',
        body: 'The matters you opened last, on any of your devices.',
      },
      {
        target: '[data-section="stats"]',
        title: 'Your numbers',
        body: 'Open matters you’re responsible for and this week’s deadlines, at a glance.',
      },
    ],
  },
  {
    id: 'matters',
    title: 'Matters',
    match: /^\/matters$/,
    steps: [
      {
        target: '[data-tour="matters-layout"]',
        title: 'List or board',
        body: 'See matters as a list, or as a board by stage: a will from instructions to signing, an estate from the death certificate to final distribution.',
      },
      {
        target: '.mt-matters-bar',
        title: 'Views and filters',
        body: 'Narrow to probate matters, one lawyer’s files or anything with overdue work. Save a combination as a view; Materia remembers the one you used last.',
      },
      {
        target: ['.mt-matters-board', 'mt-table', 'mt-phone-matters'],
        title: 'Every matter',
        body: 'Each row shows the matter number, the client and what’s due next. Open one for its tasks, documents, time and parties.',
      },
      {
        target: '[data-tour="new-matter"]',
        title: 'Open a new matter',
        body: 'Intake takes the client and the matter type, and runs a conflict check before the file opens.',
        kbd: 'c',
      },
    ],
  },
  {
    id: 'matter-documents',
    title: 'Documents',
    match: /^\/matters\/[^/]+\/documents$/,
    steps: [
      {
        target: '[data-tour="doc-upload"]',
        title: 'Add documents',
        body: 'Upload the will, the death certificate or correspondence, or drop files anywhere on this tab. Each file is scanned before anyone can open it.',
      },
      {
        target: '[data-tour="doc-template"]',
        title: 'Start from a template',
        body: 'Draft a letter to the executor or a notice to creditors from the practice’s templates, filled in from the matter.',
      },
      {
        target: '[data-tour="doc-filters"]',
        title: 'Find the right one',
        body: 'Filter by category or type, show only privileged documents, and sort by date or name.',
      },
      {
        target: '[data-tour="doc-list"]',
        title: 'The file',
        body: 'Open a document to preview it. Privileged ones carry a shield and are never sent anywhere unless you choose to.',
      },
    ],
  },
  {
    id: 'matter-time',
    title: 'Time',
    match: /^\/matters\/[^/]+\/time$/,
    steps: [
      {
        target: '[data-tour="time-entry"]',
        title: 'Record time',
        body: 'Enter the time and what you did, such as “Call with executor re: asset schedule”. Materia shows it in six-minute units.',
        kbd: 't',
      },
      {
        target: '[data-testid="time-totals"]',
        title: 'The matter’s totals',
        body: 'The units and value recorded on this matter, and how much won’t be billed.',
      },
      {
        target: '[data-tour="time-days"]',
        title: 'Day by day',
        body: 'Entries grouped by day. Change or remove one from its menu until it’s billed.',
      },
    ],
  },
  {
    id: 'matter',
    title: 'A matter',
    match: /^\/matters\/(?!new$|board$|destruction$)[^/]+(\/overview)?$/,
    steps: [
      {
        target: 'mt-matter-header',
        title: 'The matter at a glance',
        body: 'Its number, the client, the type and who’s responsible. The menu holds pinning, the conflict check and closing the file.',
      },
      {
        target: 'mt-matter-stages',
        title: 'Where it’s up to',
        body: 'The stages for this kind of matter. For an estate: from the death certificate through the grant of probate to final distribution. A new stage can bring its own tasks.',
      },
      {
        target: ['[data-tour="matter-tabs"]', 'mt-phone-matter'],
        title: 'Everything on the file',
        body: 'Tasks, deadlines, documents, time, parties and notes each have their place. Documents and Time have their own tours.',
      },
      {
        target: '[data-tour="timer"]',
        title: 'Time on this matter',
        body: 'The timer records to the matter you’re on; this shortcut starts or pauses it. Press T instead to log time you’ve already spent.',
        kbd: 'shift+t',
      },
      {
        target: '[data-tour="clerk"]',
        title: 'Ask Clerk about this matter',
        body: 'Clerk sees only this matter. Ask what’s outstanding, the next statutory step, or for a draft letter to the executor.',
        kbd: 'mod+j',
      },
    ],
  },
  {
    id: 'billing',
    title: 'Time and billing',
    match: /^\/billing$/,
    steps: [
      {
        target: '[data-tour="billing-stats"]',
        title: 'Your week and your year',
        body: 'Work in progress, hours against this week’s target, and how the financial year is tracking against budget.',
      },
      {
        target: '[data-tour="billing-tabs"]',
        title: 'Your time, WIP and approvals',
        body: 'Your own entries, the practice’s unbilled work by matter, and entries waiting for approval, depending on your role.',
      },
      {
        target: '[data-tour="record-time"]',
        title: 'Record time',
        body: 'Log time against any matter without leaving this page.',
        kbd: 't',
      },
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    match: /^\/settings(\/[^/]+)?$/,
    steps: [
      {
        target: '[data-tour="settings-nav"]',
        title: 'Settings',
        body: 'Your own profile and preferences first, then the practice’s: the team, billing rates, templates and integrations, depending on your role.',
      },
      {
        target: '[data-tour="tours-settings"]',
        title: 'Guided tours',
        body: 'Turn page tours on or off here, or take the welcome tour again.',
      },
    ],
  },
];

/** Every tour by id. */
export const TOURS: ReadonlyMap<string, Tour> = new Map([WELCOME_TOUR, ...PAGE_TOURS].map((tour) => [tour.id, tour]));

/** The page tour for a URL (query and fragment ignored), if the page has one. */
export function tourForPath(url: string): Tour | undefined {
  const path = url.split(/[?#]/)[0] ?? '';
  return PAGE_TOURS.find((tour) => tour.match?.test(path));
}
