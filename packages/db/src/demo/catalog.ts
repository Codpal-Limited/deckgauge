/**
 * The fictional company, stated once. Static, dateless and randomless — every
 * time-varying and pseudo-random aspect of the demo lives in `generate.ts`, so
 * this file can be read as "who and what", never "when".
 *
 * `key` is the logical id passed to `demoId()`. It must never change: it is the
 * identity `--remove` re-derives.
 */

export interface CatalogPerson {
  key: string;
  name: string;
  email: string;
  login: string;
  role: string;
  managerKey: string | null;
  location: string;
}

export interface CatalogBoard {
  key: string;
  name: string;
  jiraProjectKey: string;
  repoFullName: string;
  groups: string[];
}

export const COMPANY_NAME = 'Northwind Systems';

export const CATALOG_BOARDS: readonly CatalogBoard[] = [
  {
    key: 'platform',
    name: 'Demo — Platform Delivery',
    // Deliberately NOT a plausible real-world Jira key. 'PLT' is exactly that
    // — Platform — and an installer whose organization already synced a
    // project keyed 'PLT' would have their real jira_issues/transitions/
    // worklogs rows deleted by --remove's key-scoped ClickHouse delete (and
    // corrupted by the seed writing fake PLT-101… rows alongside them first).
    // No fixed key is provably collision-free, but 'DGDEMO' is implausible as
    // a real key, so the seed-time collision guard in write-postgres.ts
    // should almost never have to fire.
    jiraProjectKey: 'DGDEMO',
    repoFullName: 'northwind/platform-api',
    groups: ['Now', 'Next', 'Later', 'Shipped'],
  },
  {
    key: 'mobile',
    name: 'Demo — Mobile Squad',
    // See the platform board's comment above — same reasoning, same fix.
    jiraProjectKey: 'DGMOB',
    repoFullName: 'northwind/mobile-app',
    groups: ['In flight', 'Up next', 'Shipped'],
  },
];

export const CATALOG_STATUSES: readonly { label: string; color: string; category: string }[] = [
  { label: 'Backlog', color: '#9AA5B1', category: 'To Do' },
  { label: 'Selected', color: '#5B8DEF', category: 'To Do' },
  { label: 'In Progress', color: '#F2C94C', category: 'In Progress' },
  { label: 'In Review', color: '#BB6BD9', category: 'In Progress' },
  { label: 'Done', color: '#27AE60', category: 'Done' },
];

export const CATALOG_PEOPLE: readonly CatalogPerson[] = [
  { key: 'r.mensah', name: 'Rita Mensah', email: 'rita.mensah@northwind.example', login: 'rmensah', role: 'VP Engineering', managerKey: null, location: 'London' },

  { key: 'd.okonkwo', name: 'Deji Okonkwo', email: 'deji.okonkwo@northwind.example', login: 'dokonkwo', role: 'Director, Platform', managerKey: 'r.mensah', location: 'London' },
  { key: 's.lindqvist', name: 'Sara Lindqvist', email: 'sara.lindqvist@northwind.example', login: 'slindqvist', role: 'Director, Mobile', managerKey: 'r.mensah', location: 'Stockholm' },
  { key: 'm.ferreira', name: 'Mateus Ferreira', email: 'mateus.ferreira@northwind.example', login: 'mferreira', role: 'Engineering Manager, Data', managerKey: 'r.mensah', location: 'Lisbon' },

  { key: 'a.novak', name: 'Ana Novak', email: 'ana.novak@northwind.example', login: 'anovak', role: 'Staff Engineer', managerKey: 'd.okonkwo', location: 'Ljubljana' },
  { key: 'k.tanaka', name: 'Kenji Tanaka', email: 'kenji.tanaka@northwind.example', login: 'ktanaka', role: 'Senior Engineer', managerKey: 'd.okonkwo', location: 'Berlin' },
  { key: 'p.oyelaran', name: 'Peju Oyelaran', email: 'peju.oyelaran@northwind.example', login: 'poyelaran', role: 'Senior Engineer', managerKey: 'd.okonkwo', location: 'London' },
  { key: 'j.varga', name: 'Julia Varga', email: 'julia.varga@northwind.example', login: 'jvarga', role: 'Engineer', managerKey: 'd.okonkwo', location: 'Budapest' },
  { key: 'l.moreau', name: 'Luc Moreau', email: 'luc.moreau@northwind.example', login: 'lmoreau', role: 'Engineer', managerKey: 'd.okonkwo', location: 'Lyon' },
  { key: 'h.ibrahim', name: 'Hana Ibrahim', email: 'hana.ibrahim@northwind.example', login: 'hibrahim', role: 'Engineer', managerKey: 'd.okonkwo', location: 'Cairo' },
  { key: 'n.petrov', name: 'Nikola Petrov', email: 'nikola.petrov@northwind.example', login: 'npetrov', role: 'SRE', managerKey: 'd.okonkwo', location: 'Sofia' },
  { key: 'c.duarte', name: 'Clara Duarte', email: 'clara.duarte@northwind.example', login: 'cduarte', role: 'SRE', managerKey: 'd.okonkwo', location: 'Porto' },

  { key: 'y.ahmadi', name: 'Yara Ahmadi', email: 'yara.ahmadi@northwind.example', login: 'yahmadi', role: 'Staff Engineer, iOS', managerKey: 's.lindqvist', location: 'Stockholm' },
  { key: 'o.bergstrom', name: 'Olle Bergström', email: 'olle.bergstrom@northwind.example', login: 'obergstrom', role: 'Senior Engineer, Android', managerKey: 's.lindqvist', location: 'Stockholm' },
  { key: 'f.rossi', name: 'Fabio Rossi', email: 'fabio.rossi@northwind.example', login: 'frossi', role: 'Engineer, iOS', managerKey: 's.lindqvist', location: 'Milan' },
  { key: 't.nakamura', name: 'Toshi Nakamura', email: 'toshi.nakamura@northwind.example', login: 'tnakamura', role: 'Engineer, Android', managerKey: 's.lindqvist', location: 'Osaka' },
  { key: 'e.johansson', name: 'Elin Johansson', email: 'elin.johansson@northwind.example', login: 'ejohansson', role: 'Engineer', managerKey: 's.lindqvist', location: 'Gothenburg' },
  { key: 'w.mbeki', name: 'Wandile Mbeki', email: 'wandile.mbeki@northwind.example', login: 'wmbeki', role: 'QA Engineer', managerKey: 's.lindqvist', location: 'Cape Town' },

  { key: 'i.kaur', name: 'Ishani Kaur', email: 'ishani.kaur@northwind.example', login: 'ikaur', role: 'Senior Data Engineer', managerKey: 'm.ferreira', location: 'Bangalore' },
  { key: 'g.almeida', name: 'Gabriel Almeida', email: 'gabriel.almeida@northwind.example', login: 'galmeida', role: 'Data Engineer', managerKey: 'm.ferreira', location: 'Lisbon' },
  { key: 'z.haddad', name: 'Zeina Haddad', email: 'zeina.haddad@northwind.example', login: 'zhaddad', role: 'Analytics Engineer', managerKey: 'm.ferreira', location: 'Beirut' },
  { key: 'b.olsen', name: 'Bjørn Olsen', email: 'bjorn.olsen@northwind.example', login: 'bolsen', role: 'Data Engineer', managerKey: 'm.ferreira', location: 'Oslo' },

  { key: 'v.reyes', name: 'Valeria Reyes', email: 'valeria.reyes@northwind.example', login: 'vreyes', role: 'Product Manager', managerKey: 'd.okonkwo', location: 'Madrid' },
  { key: 'x.chen', name: 'Xiaowen Chen', email: 'xiaowen.chen@northwind.example', login: 'xchen', role: 'Product Manager', managerKey: 's.lindqvist', location: 'Singapore' },
  { key: 'q.abubakar', name: 'Qasim Abubakar', email: 'qasim.abubakar@northwind.example', login: 'qabubakar', role: 'Designer', managerKey: 'm.ferreira', location: 'Lagos' },
];
