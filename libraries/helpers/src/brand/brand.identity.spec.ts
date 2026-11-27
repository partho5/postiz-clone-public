// Feature: brand.rebrand — pins the product identity, the one color token, the removed upstream
// resources, as the contract promises them.
// Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs brand.identity --roots '<rootDir>/libraries/helpers/src'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  PRODUCT_DOMAIN,
  PRODUCT_LOGO_PATH,
  PRODUCT_NAME,
} from '@gitroom/helpers/brand/brand.identity';

const ROOT = join(__dirname, '..', '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo', 'coverage']);
const SOURCE = /\.(ts|tsx|scss|json)$/;

// Every source file under the given repo folders, skipping build output and dependencies.
const sourceFiles = (...dirs: string[]): string[] => {
  const out: string[] = [];
  // Collects the source files of one folder and its subfolders.
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE.test(name)) out.push(path);
    }
  };
  dirs.forEach((d) => walk(join(ROOT, d)));
  return out;
};

// Returns the text of a repo-relative file.
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
// Tells whether a file is a spec, which may name the product freely.
const isSpec = (file: string) => /\.spec\.ts$/.test(file);
// Returns the repo-relative path of an absolute file path.
const rel = (file: string) => relative(ROOT, file);

// Files in the app and libraries that carry product text (specs and the upstream SDK excluded).
const productSources = () =>
  sourceFiles('apps', 'libraries').filter(
    (f) => !isSpec(f) && !rel(f).startsWith('apps/sdk') && !/package\.json$/.test(f)
  );

// Primary color: the value the theme token holds in colors.scss.
const tokenValues = () =>
  [...read('apps/frontend/src/app/colors.scss').matchAll(/--new-btn-primary:\s*(#[0-9a-fA-F]{6})/g)].map(
    (m) => m[1].toLowerCase()
  );

describe('identity constants', () => {
  it('carry the product name, domain and logo path', () => {
    expect(PRODUCT_NAME).toBe('Nany Social');
    expect(PRODUCT_DOMAIN).toBe('nanybot.com');
    expect(PRODUCT_LOGO_PATH).toBe('/logo.png');
  });

  it('has the placeholder logo file at the logo path, as a PNG', () => {
    const file = join(ROOT, 'apps/frontend/public', PRODUCT_LOGO_PATH);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});

describe('name and path appear literally in one place', () => {
  it('only brand.identity.ts and the two extension manifests hold the name, domain or logo path', () => {
    const allowed = new Set([
      'libraries/helpers/src/brand/brand.identity.ts',
      'apps/extension/manifest.json',
      'apps/extension/manifest.dev.json',
    ]);
    const offenders = productSources()
      .filter((f) => !allowed.has(rel(f)))
      .filter((f) => /Nany Social|nanybot\.com|['"`]\/logo\.png['"`]/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('pins both extension manifests to the constants', () => {
    for (const file of ['apps/extension/manifest.json', 'apps/extension/manifest.dev.json']) {
      const manifest = JSON.parse(read(file));
      expect(manifest.name).toBe(PRODUCT_NAME);
      expect(manifest.description).toContain(PRODUCT_NAME);
      expect(manifest.externally_connectable.matches).toContain(`https://*.${PRODUCT_DOMAIN}/*`);
      expect(JSON.stringify(manifest)).not.toMatch(/postiz|gitroom/i);
    }
  });

  it('builds the extension trust list from the domain constant', () => {
    const background = read('apps/extension/src/background.ts');
    expect(background).toContain('PRODUCT_DOMAIN');
    expect(background).not.toMatch(/postiz/i);
  });

  it('sends PayPal the product name constant, not a second literal', () => {
    const service = read(
      'libraries/nestjs-libraries/src/database/prisma/billing/subscriptions/paypal.subscriptions.service.ts'
    );
    expect(service).toContain('PRODUCT_NAME');
    expect(service).not.toContain("'Nany Social'");
  });
});

describe('locale strings', () => {
  it('carry the name as {{productName}} and never literally', () => {
    const dir = 'libraries/react-shared-libraries/src/translation/locales';
    const offenders: string[] = [];
    for (const lang of readdirSync(join(ROOT, dir))) {
      const file = join(dir, lang, 'translation.json');
      if (!existsSync(join(ROOT, file))) continue;
      const entries = JSON.parse(read(file)) as Record<string, unknown>;
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value === 'string' && /postiz|gitroom/i.test(value)) offenders.push(`${lang}:${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('resolves {{productName}} from the product name in the one i18next instance', () => {
    const instance = read('libraries/react-shared-libraries/src/translation/i18next.ts');
    expect(instance).toMatch(/defaultVariables:\s*\{\s*productName:\s*PRODUCT_NAME\s*\}/);
  });
});

describe('primary color', () => {
  it('is #612bd3 in both themes of the one token', () => {
    expect(tokenValues()).toEqual(['#612bd3', '#612bd3']);
  });

  it('is a theme token that takes an alpha', () => {
    const config = read('apps/frontend/tailwind.config.cjs');
    expect(config).toMatch(/btnPrimary:[\s\S]*?var\(--new-btn-primary\)[\s\S]*?<alpha-value>/);
  });

  it('is written as a literal only where a class cannot reach, and those equal the token', () => {
    const token = tokenValues()[0];
    const allowed = new Set([
      'libraries/nestjs-libraries/src/chat/ui/clipping.widget.ts',
      'libraries/nestjs-libraries/src/chat/ui/upload.widget.ts',
      'libraries/nestjs-libraries/src/dtos/brands/brand.profile.schema.ts',
      'apps/frontend/src/app/global.scss',
      'apps/frontend/src/app/colors.scss',
    ]);
    const found = sourceFiles('apps/frontend/src', 'libraries')
      .filter((f) => !isSpec(f))
      .filter((f) => /#612bd3|%23612bd3|rgba?\(\s*97[\s,]+43[\s,]+211/i.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(found.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it('keeps the two widget pages, the brand default and the cursor icon on the token value', () => {
    const token = tokenValues()[0];
    const accent = /--accent:\s*(#[0-9a-fA-F]{6})/;
    for (const file of [
      'libraries/nestjs-libraries/src/chat/ui/clipping.widget.ts',
      'libraries/nestjs-libraries/src/chat/ui/upload.widget.ts',
    ]) {
      expect(read(file).match(accent)?.[1].toLowerCase()).toBe(token);
    }
    const brandDefault = read('libraries/nestjs-libraries/src/dtos/brands/brand.profile.schema.ts').match(
      /BRAND_DEFAULT_COLOR\s*=\s*'(#[0-9a-fA-F]{6})'/
    );
    expect(brandDefault?.[1].toLowerCase()).toBe(token);
    const cursor = read('apps/frontend/src/app/global.scss').match(/fill%3D%22%23([0-9a-fA-F]{6})%22/);
    expect(`#${(cursor?.[1] || '').toLowerCase()}`).toBe(token);
  });
});

describe('no upstream resource, claim or mailbox remains', () => {
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['upstream docs site', /docs\.postiz\.com/],
    ['upstream store listing', /chromewebstore\.google\.com\/detail\/postiz/],
    ['upstream affiliate program', /affiliate\.postiz\.com|postiz\.pro/],
    ['upstream directory listing', /claude\.ai\/directory\/postiz|cursor\.com\/marketplace\/postiz/],
    ['upstream CLI and skill packages', /npm install -g postiz|gitroomhq\/postiz-agent|postiz auth:login/],
    ['upstream mailbox', /nevo@postiz\.com/],
    ['upstream agency pages', /postiz\.com\/agencies/],
    ['upstream analytics site', /data-domain="postiz\.com"/],
    ['user-count claim', /20,000\+|10,000\+/],
  ];

  it.each(FORBIDDEN)('has no %s', (_label, pattern) => {
    const offenders = productSources()
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('has deleted the testimonial files', () => {
    for (const file of [
      'libraries/react-shared-libraries/src/helpers/testomonials.tsx',
      'apps/frontend/src/components/auth/testimonial.component.tsx',
      'apps/frontend/src/components/auth/testimonial.tsx',
    ]) {
      expect(existsSync(join(ROOT, file))).toBe(false);
    }
  });

  it('starts the product-named digest under a workflow id no old digest instance holds', () => {
    const service = read('libraries/nestjs-libraries/src/database/prisma/notifications/notification.service.ts');
    const started = service.match(/signalWithStart\('digestEmailWorkflowV101',\s*\{\s*workflowId:\s*([^,]+),/);
    expect(started).not.toBeNull();
    expect(started![1].replace(/\s+/g, '')).not.toMatch(/^'digest_email_workflow_'\+/);
  });

  it('sends the agency mail to the operator address', () => {
    const service = read('libraries/nestjs-libraries/src/database/prisma/agencies/agencies.service.ts');
    expect(service).toContain('process.env.EMAIL_FROM_ADDRESS');
  });
});

describe('attribution', () => {
  it('keeps the AGPL license', () => {
    expect(read('LICENSE')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
  });
});
