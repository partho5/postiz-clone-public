// api.scoped-keys: what the source must say. Needs no database. Reads the real public
// controller, the modules and the whole source tree with the TypeScript parser and the file
// system rather than importing them: the real controllers pull in ES-module-only packages jest here
// cannot load, and what the decorators and modules list is exactly what Nest registers.
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const root = path.resolve(__dirname, '../../../../../..');

// Parses a source file given by its path under the repo root.
const sourceOf = (file: string) => {
  const full = path.resolve(root, file);
  return ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
};

// The decorators of a node, as { name, args } with string-literal arguments unquoted.
const decoratorsOf = (node: ts.Node) =>
  (ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []).flatMap((decorator) => {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
      return [];
    }
    return [
      {
        name: expression.expression.text,
        args: expression.arguments.map((arg) =>
          ts.isStringLiteralLike(arg) ? arg.text : arg.getText()
        ),
      },
    ];
  });

// Every route method of the class in the file: its HTTP verb, path and the scope it names (or undefined).
const routesOf = (file: string, className: string) => {
  const found: { verb: string; route: string; scope?: string; method: string }[] = [];
  // Walks the file for the class and reads each of its decorated methods.
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) {
          continue;
        }
        const decorators = decoratorsOf(member);
        const verb = decorators.find((d) =>
          ['Get', 'Post', 'Put', 'Delete', 'Patch'].includes(d.name)
        );
        if (verb) {
          found.push({
            verb: verb.name.toUpperCase(),
            route: verb.args[0] ?? '',
            scope: decorators.find((d) => d.name === 'RequireScope')?.args[0],
            method: (member.name as ts.Identifier).text,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(file));
  return found;
};

// Every identifier inside the initializer of a property or variable of the file.
const listed = (file: string, name: string) => {
  const names: string[] = [];
  // Walks the file for the property or variable and collects its identifiers.
  const visit = (node: ts.Node) => {
    const matches =
      (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === name) ||
      (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
    const initializer = matches ? (node as ts.PropertyAssignment | ts.VariableDeclaration).initializer : undefined;
    if (initializer) {
      // Adds every identifier under the node to the list.
      const collect = (inner: ts.Node) => {
        if (ts.isIdentifier(inner)) {
          names.push(inner.text);
        }
        ts.forEachChild(inner, collect);
      };
      collect(initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(file));
  return names;
};

const publicController = 'apps/backend/src/public-api/routes/v1/public.integrations.controller.ts';

// The scope the contract gives each public route.
const contractScopes: Record<string, string> = {
  'GET /find-slot/:id': 'posts:read',
  'GET /posts': 'posts:read',
  'GET /groups': 'posts:read',
  'POST /posts': 'posts:write',
  'GET /posts/status': 'posts:read',
  'GET /auto-publish': 'posts:read',
  'POST /auto-publish': 'posts:write',
  'PUT /auto-publish/channels/:integrationId': 'posts:write',
  'PUT /auto-publish/text-channels/:integrationId': 'posts:write',
  'DELETE /posts/:id': 'posts:write',
  'DELETE /posts/group/:group': 'posts:write',
  'POST /upload': 'media:write',
  'POST /upload/multipart': 'media:write',
  'POST /upload/multipart/:id/parts': 'media:write',
  'GET /upload/multipart/:id': 'media:write',
  'POST /upload/multipart/:id/complete': 'media:write',
  'DELETE /upload/multipart/:id': 'media:write',
  'POST /upload-from-url': 'media:write',
  'GET /integrations': 'channels:read',
  'GET /platforms': 'channels:read',
  'GET /is-connected': 'channels:read',
  'GET /integration-settings/:id': 'channels:read',
  'GET /social/:integration': 'channels:read',
  'DELETE /integrations/:id': 'channels:write',
  'POST /generate-video': 'ai:use',
  'POST /video/function': 'ai:use',
  'POST /clipping': 'ai:use',
  'GET /clipping': 'ai:use',
  'GET /clipping/:id': 'ai:use',
  'POST /ai-captions': 'posts:write',
  'GET /ai-captions/:id': 'posts:read',
  'GET /ai-edits/contract': 'posts:read',
  'GET /ai-edits/quote': 'posts:read',
  'POST /ai-edits': 'posts:write',
  'GET /ai-edits/:id': 'posts:read',
  'GET /users': 'account:read',
  'GET /notifications': 'account:read',
  'GET /debug/posts/:id': 'account:read',
  'GET /debug/account': 'account:read',
  'GET /debug/channels': 'account:read',
  'GET /debug/activity': 'account:read',
  'GET /posts/:id/missing': 'posts:read',
  'PUT /posts/:id/settings': 'posts:write',
  'PUT /posts/:id/status': 'posts:write',
  'PUT /posts/:id/release-id': 'posts:write',
  'GET /analytics/:integration': 'channels:read',
  'GET /analytics/post/:postId': 'posts:read',
  'POST /integration-trigger/:id': 'channels:write',
};

// Every non-test source file under the given directories, node_modules and build output left out.
const sourceFiles = (dirs: string[]) => {
  const files: string[] = [];
  // Collects the TypeScript sources below a directory.
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.next', 'migrations'].includes(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  dirs.forEach((dir) => walk(path.resolve(root, dir)));
  return files;
};

describe('api.scoped-keys: the public routes', () => {
  const routes = routesOf(publicController, 'PublicIntegrationsController');

  it('every route of the public controller names the scope the contract gives it', () => {
    const actual = Object.fromEntries(
      routes.map((r) => [`${r.verb} ${r.route}`, r.scope])
    );

    expect(actual).toEqual(contractScopes);
  });

  it('the public controller runs the scope guard', () => {
    const guards = (() => {
      let found: string[] = [];
      // Walks the file for the controller class and reads its UseGuards arguments.
      const visit = (node: ts.Node) => {
        if (ts.isClassDeclaration(node) && node.name?.text === 'PublicIntegrationsController') {
          found = decoratorsOf(node)
            .filter((d) => d.name === 'UseGuards')
            .flatMap((d) => d.args);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceOf(publicController));
      return found;
    })();

    expect(guards).toContain('ScopeGuard');
  });
});

describe('api.scoped-keys: registration', () => {
  it('ApiModule serves the key controller behind authentication', () => {
    expect(listed('apps/backend/src/api/api.module.ts', 'authenticatedController')).toContain(
      'ApiKeysController'
    );
  });

  it('DatabaseModule provides the key repository and service', () => {
    const providers = listed('libraries/nestjs-libraries/src/database/prisma/database.module.ts', 'providers');

    expect(providers).toEqual(expect.arrayContaining(['ApiKeysRepository', 'ApiKeysService']));
  });

  it('the key controller has the contract routes', () => {
    const routes = routesOf('apps/backend/src/api/routes/api-keys.controller.ts', 'ApiKeysController').map(
      (r) => `${r.verb} ${r.route}`
    );

    expect(routes.sort()).toEqual(['DELETE /:id', 'GET /', 'POST /'].sort());
  });
});

describe('api.scoped-keys: no code path reads Organization.apiKey', () => {
  const files = sourceFiles([
    'apps/backend/src',
    'apps/frontend/src',
    'apps/orchestrator/src',
    'apps/extension/src',
    'libraries',
    'e2e',
  ]);

  // The files whose text matches a pattern, as repo-relative paths.
  const matching = (pattern: RegExp) =>
    files
      .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));

  it('getOrgByApiKey and updateApiKey exist nowhere', () => {
    expect(matching(/getOrgByApiKey|updateApiKey/)).toEqual([]);
  });

  it('the rotate route and the publicApi field of /user/self exist nowhere', () => {
    expect(matching(/api-key\/rotate/)).toEqual([]);
    expect(matching(/\bpublicApi\b/)).toEqual([]);
  });

  it('no organization or workspace value has its apiKey read', () => {
    expect(
      matching(/\b(org|organization|workspace|setOrg|overrideOrg|auth)\w*\??\.apiKey\b/)
    ).toEqual([]);
  });

  it('no organization query selects, filters or writes the legacy column', () => {
    const offenders = files.filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return (
        /organization\.(model\.organization\.)?(create|update|findFirst|findMany|findUnique)/.test(text) &&
        /\bapiKey\s*:/.test(text)
      );
    });

    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  });

  it('the connect webhook payload carries no key', () => {
    const text = fs.readFileSync(
      path.resolve(root, 'apps/backend/src/api/routes/no.auth.integrations.controller.ts'),
      'utf8'
    );

    expect(text).not.toMatch(/signJWT\(\{[^}]*apiKey/);
    expect(text).not.toMatch(/\.apiKey/);
  });
});
