// Root lint config, run by `pnpm lint`. Tenancy: app navigation in the
// web app keeps the tab's /w/<id> prefix.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

// A string that starts with "/" is an app path
const APP_PATH = '/^\\//';

// Navigations that take an app path: assignments to window.location.href,
// window.location.assign/replace, (window.)history.pushState/replaceState and window.open
const LOCATION_HREF =
  "AssignmentExpression[left.object.object.name='window'][left.object.property.name='location'][left.property.name='href']";
const LOCATION_CALL =
  "CallExpression[callee.object.object.name='window'][callee.object.property.name='location'][callee.property.name=/^(assign|replace)$/]";
const HISTORY_CALL =
  "CallExpression:matches([callee.object.name='history'], [callee.object.object.name='window'][callee.object.property.name='history'])[callee.property.name=/^(pushState|replaceState)$/]";
const WINDOW_OPEN =
  "CallExpression[callee.object.name='window'][callee.property.name='open']";

const NAVIGATION_MESSAGE =
  "App navigation keeps the tab's /w/<id> prefix: use WorkspaceLink, useWorkspaceRouter or workspacePath() (components/layout/workspace.navigation.tsx, helpers/utils/workspace.path.ts).";

// Deepest concatenation searched for a leading app path ('/a' + b + … , 9 operands)
const CONCATENATION_DEPTH = 8;

// Selectors for a literal app path at `position` of a navigation: a string, a
// template, or a concatenation whose first operand is one
const literalAppPath = (navigation, position) => {
  const starts = (node) => [
    `Literal${node}[value=${APP_PATH}]`,
    `TemplateLiteral${node} > TemplateElement:first-child[value.raw=${APP_PATH}]`,
  ];
  const targets = [...starts(position)];
  for (let depth = 1; depth <= CONCATENATION_DEPTH; depth++) {
    const concatenation = [`BinaryExpression${position}`]
      .concat(Array(depth - 1).fill('BinaryExpression.left'))
      .join(' > ');
    targets.push(...starts('.left').map((start) => `${concatenation} > ${start}`));
  }
  return targets.map((target) => ({
    selector: `${navigation} > ${target}`,
    message: NAVIGATION_MESSAGE,
  }));
};

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    settings: {
      next: {
        rootDir: 'apps/frontend',
      },
    },
    rules: {
      'react/no-unescaped-entities': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'react/display-name': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/prefer-as-const': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
      // React Compiler rules of eslint-plugin-react-hooks 7: reported, not failing
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/use-memo': 'warn',
    },
  },
  {
    // A jest.mock factory is hoisted above the imports, so it can only reach a module with require
    files: ['**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['apps/frontend/src/**'],
    ignores: ['apps/frontend/src/components/layout/workspace.navigation.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next/link', message: NAVIGATION_MESSAGE },
            {
              name: 'next/navigation',
              importNames: ['useRouter', 'redirect'],
              message: NAVIGATION_MESSAGE,
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...literalAppPath(LOCATION_HREF, '.right'),
        ...literalAppPath(LOCATION_CALL, '.arguments:first-child'),
        ...literalAppPath(HISTORY_CALL, '.arguments:nth-child(3)'),
        ...literalAppPath(WINDOW_OPEN, '.arguments:first-child'),
      ],
    },
  },
];

export default eslintConfig;
