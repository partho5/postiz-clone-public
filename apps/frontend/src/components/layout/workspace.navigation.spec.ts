// Tenancy: the root lint rules that keep every in-app navigation on the
// tab's /w/<id> prefix, checked against the real root config (`pnpm lint`).
// Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/apps/frontend/src' workspace.navigation
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const NAVIGATION_RULES = ['no-restricted-imports', 'no-restricted-syntax'];
const COMPONENT = 'apps/frontend/src/components/launches/example.component.tsx';
const PAGE = 'apps/frontend/src/app/(app)/(site)/example/page.tsx';
const NAVIGATION_HELPERS = 'apps/frontend/src/components/layout/workspace.navigation.tsx';
const OUTSIDE_FRONTEND = 'libraries/react-shared-libraries/src/example.component.tsx';
const CALENDAR_CONTEXT = 'apps/frontend/src/components/launches/calendar.context.tsx';

type Message = { ruleId: string | null; severity: number; line: number };
type Snippet = { name: string; filePath: string; code: string };

// Lints each snippet as if it were the given file, with the repo's root config,
// in a child Node process (the config is an ES module, which ts-jest cannot load).
const lintSnippets = (snippets: Snippet[]): Record<string, Message[]> => {
  const script = `
    const { loadESLint } = require('eslint');
    let input = '';
    process.stdin.on('data', (chunk) => (input += chunk));
    process.stdin.on('end', async () => {
      const ESLint = await loadESLint({ useFlatConfig: true });
      const eslint = new ESLint({ cwd: process.cwd() });
      const out = {};
      for (const { name, filePath, code } of JSON.parse(input)) {
        const [result] = await eslint.lintText(code, { filePath });
        out[name] = result.messages.map(({ ruleId, severity, line }) => ({ ruleId, severity, line }));
      }
      process.stdout.write(JSON.stringify(out));
    });
  `;
  const result = spawnSync('node', ['-e', script], {
    cwd: ROOT,
    input: JSON.stringify(snippets),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return JSON.parse(result.stdout);
};

// Only the messages of the navigation rules
const navigation = (messages: Message[]) =>
  messages.filter((m) => NAVIGATION_RULES.includes(m.ruleId || ''));

const forbidden: Snippet[] = [
  { name: 'next/link default import', filePath: COMPONENT, code: `import Link from 'next/link';\nexport const A = () => <Link href="/launches">x</Link>;\n` },
  { name: 'next/link named import', filePath: COMPONENT, code: `import NextLink, { useLinkStatus } from 'next/link';\nexport const A = [NextLink, useLinkStatus];\n` },
  { name: 'useRouter from next/navigation', filePath: COMPONENT, code: `import { useRouter } from 'next/navigation';\nexport const A = useRouter;\n` },
  { name: 'useRouter beside allowed hooks', filePath: COMPONENT, code: `import { useSearchParams, useRouter } from 'next/navigation';\nexport const A = [useSearchParams, useRouter];\n` },
  { name: 'redirect from next/navigation in a page', filePath: PAGE, code: `import { redirect } from 'next/navigation';\nexport default function Page() {\n  return redirect('/agents/new');\n}\n` },
  { name: 'href = string app path', filePath: COMPONENT, code: `export const go = () => {\n  window.location.href = '/launches';\n};\n` },
  { name: 'href = template app path', filePath: COMPONENT, code: 'export const go = (id: string) => {\n  window.location.href = `/launches?id=${id}`;\n};\n' },
  { name: 'href = concatenated app path', filePath: COMPONENT, code: `export const go = (id: string) => {\n  window.location.href = '/launches?id=' + id;\n};\n` },
  { name: 'href = concatenated template app path', filePath: COMPONENT, code: 'export const go = (id: string) => {\n  window.location.href = `/launches/${id}` + "?x=1";\n};\n' },
  { name: 'assign(string app path)', filePath: COMPONENT, code: `export const go = () => {\n  window.location.assign('/settings');\n};\n` },
  { name: 'replace(template app path)', filePath: COMPONENT, code: 'export const go = () => {\n  window.location.replace(`/billing`);\n};\n' },
  { name: 'bare / without an allowance', filePath: COMPONENT, code: `export const go = () => {\n  window.location.href = '/';\n};\n` },
  { name: 'href = five-part concatenated app path', filePath: COMPONENT, code: `export const go = (a: string, b: string, c: string) => {\n  window.location.href = '/launches?a=' + a + '&b=' + b + c;\n};\n` },
  // Verdict 1 finding 1: the calendar filter line that dropped the prefix
  { name: 'calendar filter replaceState (verdict 1)', filePath: CALENDAR_CONTEXT, code: "export const setFilters = (path: string[]) => {\n      window.history.replaceState(null, '', `/launches?${path.join('&')}`);\n};\n" },
  { name: 'history.pushState without window', filePath: COMPONENT, code: `export const go = () => {\n  history.pushState({}, '', '/settings');\n};\n` },
  { name: 'window.history.pushState concatenated app path', filePath: COMPONENT, code: `export const go = (id: string) => {\n  window.history.pushState(null, '', '/launches?id=' + id);\n};\n` },
  { name: 'history.replaceState template app path', filePath: COMPONENT, code: 'export const go = () => {\n  history.replaceState(null, "", `/analytics`);\n};\n' },
  { name: 'window.open(string app path)', filePath: COMPONENT, code: `export const go = () => {\n  window.open('/billing', '_blank');\n};\n` },
  { name: 'window.open(concatenated app path)', filePath: COMPONENT, code: "export const go = (id: string) => {\n  window.open(`/p/` + id + '?share=true', '_blank');\n};\n" },
];

const allowed: Snippet[] = [
  { name: 'other next/navigation hooks', filePath: COMPONENT, code: `import { usePathname, useSearchParams, useParams } from 'next/navigation';\nexport const A = [usePathname, useSearchParams, useParams];\n` },
  { name: 'workspace navigation helpers', filePath: COMPONENT, code: `import { useWorkspaceRouter, WorkspaceLink } from '@gitroom/frontend/components/layout/workspace.navigation';\nexport const A = [useWorkspaceRouter, WorkspaceLink];\n` },
  { name: 'href = workspacePath(app path)', filePath: COMPONENT, code: `import { workspacePath } from '@gitroom/helpers/utils/workspace.path';\nexport const go = () => {\n  window.location.href = workspacePath('/launches');\n};\n` },
  { name: 'assign/replace with workspacePath', filePath: COMPONENT, code: `import { workspacePath } from '@gitroom/helpers/utils/workspace.path';\nexport const go = () => {\n  window.location.assign(workspacePath('/a'));\n  window.location.replace(workspacePath('/b'));\n};\n` },
  { name: 'href = external URL or variable', filePath: COMPONENT, code: `export const go = (url: string) => {\n  window.location.href = 'https://example.com/pay';\n  window.location.href = url;\n};\n` },
  { name: 'bare / exit allowed per line with a reason', filePath: COMPONENT, code: `export const go = () => {\n  // eslint-disable-next-line no-restricted-syntax -- bare / exit: logout\n  window.location.href = '/';\n};\n` },
  { name: 'unscoped page allowed per line with a reason', filePath: COMPONENT, code: `export const go = () => {\n  // eslint-disable-next-line no-restricted-syntax -- unscoped: /auth\n  window.location.href = '/auth/login';\n};\n` },
  { name: 'workspace.navigation.tsx itself', filePath: NAVIGATION_HELPERS, code: `import NextLink from 'next/link';\nimport { useRouter, redirect } from 'next/navigation';\nexport const A = [NextLink, useRouter, redirect];\nexport const go = () => {\n  window.location.href = '/';\n};\n` },
  { name: 'history API with workspacePath', filePath: COMPONENT, code: "import { workspacePath } from '@gitroom/helpers/utils/workspace.path';\nexport const go = (path: string[]) => {\n  window.history.replaceState(null, '', workspacePath(`/launches?${path.join('&')}`));\n  history.pushState('/state-is-not-a-url', '', workspacePath('/settings'));\n};\n" },
  { name: 'window.open external URL or workspacePath', filePath: COMPONENT, code: "import { workspacePath } from '@gitroom/helpers/utils/workspace.path';\nexport const go = (id: string) => {\n  window.open('https://example.com/docs', '_blank');\n  window.open(workspacePath(`/p/` + id + '?share=true'), '_blank');\n};\n" },
  { name: 'outside apps/frontend/src', filePath: OUTSIDE_FRONTEND, code: `import Link from 'next/link';\nexport const A = Link;\nexport const go = () => {\n  window.location.href = '/launches';\n};\n` },
];

const hooks: Snippet[] = [
  { name: 'React Compiler rule', filePath: COMPONENT, code: `import { useEffect, useState } from 'react';\nexport const A = () => {\n  const [a, setA] = useState(0);\n  useEffect(() => {\n    setA(1);\n  }, []);\n  return a;\n};\n` },
  { name: 'rules-of-hooks', filePath: COMPONENT, code: `import { useState } from 'react';\nexport const A = (p: { x: boolean }) => {\n  if (p.x) {\n    useState(0);\n  }\n  return null;\n};\n` },
];

describe('tenancy.nav-prefix lint rules (root ESLint config)', () => {
  let results: Record<string, Message[]>;

  beforeAll(() => {
    const calendar: Snippet = {
      name: 'calendar.context.tsx as committed',
      filePath: CALENDAR_CONTEXT,
      code: readFileSync(join(ROOT, CALENDAR_CONTEXT), 'utf8'),
    };
    results = lintSnippets([...forbidden, ...allowed, ...hooks, calendar]);
  }, 120000);

  it.each(forbidden.map((s) => [s.name]))('fails on %s', (name) => {
    const found = navigation(results[name]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((m) => m.severity === 2)).toBe(true);
  });

  it('reports each forbidden import and navigation on its own line', () => {
    expect(navigation(results['useRouter beside allowed hooks']).map((m) => m.line)).toEqual([1]);
    expect(navigation(results['redirect from next/navigation in a page']).map((m) => m.line)).toEqual([1]);
    expect(navigation(results['href = string app path']).map((m) => m.line)).toEqual([2]);
    expect(navigation(results['assign(string app path)']).map((m) => m.line)).toEqual([2]);
    expect(navigation(results['calendar filter replaceState (verdict 1)']).map((m) => m.line)).toEqual([2]);
  });

  it('passes the calendar filters as committed (verdict 1)', () => {
    expect(navigation(results['calendar.context.tsx as committed'])).toEqual([]);
  });

  it.each(allowed.map((s) => [s.name]))('passes %s', (name) => {
    expect(navigation(results[name])).toEqual([]);
  });

  it('keeps the React Compiler rules as warnings and rules-of-hooks as an error', () => {
    const compiler = results['React Compiler rule'].filter((m) => m.ruleId === 'react-hooks/set-state-in-effect');
    expect(compiler.length).toBeGreaterThan(0);
    expect(compiler.every((m) => m.severity === 1)).toBe(true);
    const rulesOfHooks = results['rules-of-hooks'].filter((m) => m.ruleId === 'react-hooks/rules-of-hooks');
    expect(rulesOfHooks.length).toBeGreaterThan(0);
    expect(rulesOfHooks.every((m) => m.severity === 2)).toBe(true);
  });

  it('`pnpm lint` exits 0 on apps/frontend/src', () => {
    const result = spawnSync('pnpm', ['lint'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(result.status).toBe(0);
  }, 300000);
});
