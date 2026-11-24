// Idempotency-Key: ApiModule and PublicApiModule register IdempotencyMiddleware on every
// authenticated controller, directly after the authentication middleware, so the principal and
// workspace are known when it runs. Needs no database. It reads the modules' source with the
// TypeScript parser rather than importing them: the real controllers pull in ES-module-only
// packages jest here cannot load, and the registration is exactly what `configure` says.
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

type Registration = { middleware: string[]; routes: string[] };

// Parses a backend source file given by its path under apps/backend/src.
const sourceOf = (file: string) => {
  const full = path.resolve(__dirname, '../../../../../../apps/backend/src', file);
  return ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
};

// The names an argument list refers to, expanding a spread of a same-file array constant
// (`...authenticatedController`) into the identifiers inside that array.
const namesOf = (source: ts.SourceFile, args: readonly ts.Expression[]) => {
  const arrays = new Map<string, string[]>();
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) {
      return;
    }
    for (const declaration of node.declarationList.declarations) {
      const init = declaration.initializer;
      if (ts.isIdentifier(declaration.name) && init && ts.isArrayLiteralExpression(init)) {
        arrays.set(
          declaration.name.text,
          init.elements.filter(ts.isIdentifier).map((e) => e.text)
        );
      }
    }
  });
  return args.flatMap((arg) =>
    ts.isSpreadElement(arg) && ts.isIdentifier(arg.expression)
      ? arrays.get(arg.expression.text) ?? []
      : ts.isIdentifier(arg)
      ? [arg.text]
      : []
  );
};

// Every `consumer.apply(...middleware).forRoutes(...routes)` in a module's source, in order.
const registrationsOf = (file: string) => {
  const source = sourceOf(file);
  const registered: Registration[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'forRoutes' &&
      ts.isCallExpression(node.expression.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression.expression) &&
      node.expression.expression.expression.name.text === 'apply'
    ) {
      registered.push({
        middleware: namesOf(source, node.expression.expression.arguments),
        routes: namesOf(source, node.arguments),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return registered;
};

// The registration that carries a given authentication middleware.
const authRegistration = (file: string, auth: string) =>
  registrationsOf(file).find((r) => r.middleware.includes(auth));

describe('IdempotencyMiddleware registration', () => {
  it('runs on the authenticated API directly after AuthMiddleware', () => {
    const registration = authRegistration('api/api.module.ts', 'AuthMiddleware');

    expect(registration).toBeDefined();
    expect(registration!.middleware.indexOf('IdempotencyMiddleware')).toBe(
      registration!.middleware.indexOf('AuthMiddleware') + 1
    );
  });

  it('covers the authenticated mutation controllers and none of the unauthenticated ones', () => {
    const routes = authRegistration('api/api.module.ts', 'AuthMiddleware')!.routes;

    expect(routes).toEqual(
      expect.arrayContaining([
        'PostsController',
        'BillingController',
        'TopupsController',
        'PlansController',
        'CopilotController',
        'MediaController',
      ])
    );
    for (const open of [
      'PaymentController',
      'AuthController',
      'NoAuthIntegrationsController',
      'OAuthController',
    ]) {
      expect(routes).not.toContain(open);
    }
  });

  it('runs on the public API directly after PublicAuthMiddleware, on its controllers', () => {
    const registration = authRegistration(
      'public-api/public.api.module.ts',
      'PublicAuthMiddleware'
    );

    expect(registration).toBeDefined();
    expect(registration!.middleware.indexOf('IdempotencyMiddleware')).toBe(
      registration!.middleware.indexOf('PublicAuthMiddleware') + 1
    );
    expect(registration!.routes).toContain('PublicIntegrationsController');
  });
});
