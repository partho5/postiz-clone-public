// api.token-auth: ApiModule registers the token controller, services and limiter, and
// DatabaseModule the device-session repository; the token endpoint is open (nothing authenticates
// the request that asks for a token). Needs no database. It reads the modules' source with the
// TypeScript parser rather than importing them: the real controllers pull in ES-module-only packages
// jest here cannot load, and what the modules list is exactly what Nest registers.
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

// Parses a source file given by its path under the repo root.
const sourceOf = (file: string) => {
  const full = path.resolve(__dirname, '../../../../../..', file);
  return ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
};

// Every identifier inside the initializer of a property (`providers`, `controllers`) of the file's @Module.
const moduleList = (file: string, property: string) => {
  const names: string[] = [];
  // Walks the file for the property and collects its identifiers.
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === property
    ) {
      // Adds every identifier under the node to the list.
      const collect = (inner: ts.Node) => {
        if (ts.isIdentifier(inner)) {
          names.push(inner.text);
        }
        ts.forEachChild(inner, collect);
      };
      collect(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(file));
  return names;
};

// The identifiers in a same-file array constant (`authenticatedController`).
const constantList = (file: string, name: string) => {
  const names: string[] = [];
  sourceOf(file).forEachChild((node) => {
    if (!ts.isVariableStatement(node)) {
      return;
    }
    for (const declaration of node.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer &&
        ts.isArrayLiteralExpression(declaration.initializer)
      ) {
        names.push(
          ...declaration.initializer.elements.filter(ts.isIdentifier).map((e) => e.text)
        );
      }
    }
  });
  return names;
};

describe('token auth registration', () => {
  const apiModule = 'apps/backend/src/api/api.module.ts';

  it('ApiModule provides the token service, the grants service and the attempt limiter', () => {
    expect(moduleList(apiModule, 'providers')).toEqual(
      expect.arrayContaining(['TokenService', 'TokenGrantsService', 'AuthAttemptLimiter'])
    );
  });

  it('ApiModule serves the token controller, with the other open authentication routes', () => {
    expect(moduleList(apiModule, 'controllers')).toContain('AuthTokenController');
    expect(constantList(apiModule, 'authenticatedController')).not.toContain(
      'AuthTokenController'
    );
  });

  it('DatabaseModule provides the device-session repository', () => {
    expect(
      moduleList('libraries/nestjs-libraries/src/database/prisma/database.module.ts', 'providers')
    ).toContain('DeviceSessionsRepository');
  });
});
