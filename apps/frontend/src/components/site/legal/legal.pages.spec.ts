// Legal pages: the three legal pages are public and unscoped, take the operator
// and contact from the brand constants, and name only third parties the code really calls.
// Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs legal.pages --roots '<rootDir>/apps/frontend/src'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { NextRequest } from 'next/server';
import {
  PRODUCT_CONTACT_EMAIL,
  PRODUCT_DOMAIN,
  PRODUCT_NAME,
  PRODUCT_OPERATOR,
} from '@gitroom/helpers/brand/brand.identity';
import { workspacePath } from '@gitroom/helpers/utils/workspace.path';

// The proxy reads its language settings from a package the spec runner does not map.
jest.mock(
  '@gitroom/react/translation/i18n.config',
  () => ({ cookieName: 'i18next', headerName: 'x-i18next', languages: ['en'] }),
  { virtual: true }
);

import { proxy } from '../../../proxy';

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const PATHS = ['/terms', '/privacy', '/data-deletion'];
const WORKSPACE = '123e4567-e89b-12d3-a456-426614174000';
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo', 'coverage']);

// Returns the text of a repo-relative file.
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
// Returns the source of one legal page.
const page = (name: string) =>
  read(`apps/frontend/src/app/(app)/(legal)/${name}/page.tsx`);

// Collects every non-spec .ts/.tsx source under the given repo folders.
const sources = (...dirs: string[]): string => {
  const out: string[] = [];
  // Walks one folder and its subfolders.
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.spec\.ts$/.test(name)) {
        out.push(readFileSync(path, 'utf8'));
      }
    }
  };
  dirs.forEach((d) => walk(join(ROOT, d)));
  return out.join('\n');
};

// Sends one request through the frontend proxy and returns its response.
const visit = (path: string, signedIn: boolean) =>
  proxy(
    new NextRequest(`http://localhost:4200${path}`, {
      headers: signedIn ? { cookie: 'auth=token' } : {},
    })
  );

describe('legal pages', () => {
  describe('operator and contact constants', () => {
    it('derive the contact address and operator wording from the product domain', () => {
      expect(PRODUCT_CONTACT_EMAIL).toBe(`contact@${PRODUCT_DOMAIN}`);
      expect(PRODUCT_OPERATOR).toBe(`the operator of ${PRODUCT_DOMAIN}`);
    });

    it('appear in no page as a literal', () => {
      for (const name of ['terms', 'privacy', 'data-deletion']) {
        const source = page(name);
        expect(source).not.toMatch(/contact@/);
        expect(source).not.toContain(PRODUCT_DOMAIN);
        expect(source).not.toContain(PRODUCT_NAME);
        expect(source).not.toMatch(/the operator of/i);
        expect(source).toContain('PRODUCT_CONTACT_EMAIL');
        expect(source).toContain('PRODUCT_OPERATOR');
      }
    });
  });

  describe('public and unscoped paths', () => {
    it.each(PATHS)('%s answers a signed-out visitor without a redirect', async (path) => {
      const response = await visit(path, false);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-next')).toBe('1');
    });

    it.each(PATHS)('%s answers a signed-in visitor without a redirect', async (path) => {
      const response = await visit(path, true);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-next')).toBe('1');
    });

    it('still sends a signed-out visitor from an app page to sign-in', async () => {
      const response = await visit('/launches', false);
      expect(response.headers.get('location')).toContain('/auth');
    });

    it.each(PATHS)('%s is never prefixed with the tab workspace', (path) => {
      expect(workspacePath(path, WORKSPACE)).toBe(path);
    });

    it('prefixes an ordinary app page, as before', () => {
      expect(workspacePath('/launches', WORKSPACE)).toBe(`/w/${WORKSPACE}/launches`);
    });
  });

  describe('links', () => {
    it('the root layout renders the legal links', () => {
      const layout = read('apps/frontend/src/app/(app)/layout.tsx');
      expect(layout).toContain('<LegalLinks />');
    });

    it('LegalLinks points at the three pages', () => {
      const links = read('apps/frontend/src/components/site/legal/legal.links.tsx');
      for (const path of PATHS) {
        expect(links).toContain(`'${path}'`);
      }
    });

    it('each page folder exists', () => {
      for (const name of ['terms', 'privacy', 'data-deletion']) {
        expect(existsSync(join(ROOT, `apps/frontend/src/app/(app)/(legal)/${name}/page.tsx`))).toBe(true);
      }
    });
  });

  describe('content', () => {
    it('the terms state no cash refunds and the three credit expiry rules, without an amount', () => {
      const terms = page('terms');
      expect(terms).toMatch(/no cash refunds/i);
      expect(terms).toMatch(/never expire/i);
      expect(terms).toMatch(/reset at each billing period/i);
      expect(terms).toMatch(/Free credits reset every month/i);
      expect(terms).not.toMatch(/\$\s?\d|\d+\s?credits/i);
    });

    it('the data-deletion page names the in-app action and the mail address', () => {
      const deletion = page('data-deletion');
      expect(deletion).toMatch(/Delete Account/);
      expect(deletion).toContain('PRODUCT_CONTACT_EMAIL');
    });

    it('the privacy page says what AI captions send to Meta and OpenAI, that the stored audio is deleted and that transcripts are kept until deleted', () => {
      const privacy = page('privacy').replace(/\s+/g, ' ');
      expect(privacy).toMatch(/Meta Muse Transcribe receives the voice audio of your recording/);
      expect(privacy).toMatch(/stored audio is deleted once it is transcribed/);
      expect(privacy).toMatch(/OpenAI receives the transcript/);
      expect(privacy).toMatch(/transcript is kept until you delete it/);
    });

    it('the privacy page says the content plan sends business details to Meta, which may use them to improve its models', () => {
      const privacy = page('privacy').replace(/\s+/g, ' ');
      expect(privacy).toMatch(/content plan, the business details you enter there are sent to Meta/);
      expect(privacy).toMatch(/Meta may use them to improve its models/);
    });

    it('name no person and no country on any page', () => {
      for (const name of ['terms', 'privacy', 'data-deletion']) {
        expect(page(name)).not.toMatch(
          /\b(Bangladesh|India|Pakistan|United States|USA|Germany|France|United Kingdom|Canada|Australia)\b/
        );
      }
    });
  });

  describe('third parties agree with the code', () => {
    // Tells whether the page names a service as a whole word, so "fal" is not found inside "fallback".
    const named = (text: string, name: string) =>
      new RegExp(`(^|[^A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`).test(text);

    // Collects the source of every non-spec .ts/.tsx file whose path passes `keep`, with its path.
    const filesWhere = (keep: (path: string) => boolean): Array<[string, string]> => {
      const out: Array<[string, string]> = [];
      // Walks one folder and its subfolders.
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          if (SKIP_DIRS.has(name)) continue;
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path);
          else if (/\.tsx?$/.test(name) && !/\.spec\.ts$/.test(name) && keep(path)) {
            out.push([path, readFileSync(path, 'utf8')]);
          }
        }
      };
      ['apps', 'libraries'].forEach((d) => walk(join(ROOT, d)));
      return out;
    };

    // The services the privacy page names, each with the env key that selects it in the code.
    const SERVICES: Array<[string, RegExp]> = [
      ['PayPal', /^PAYPAL_/],
      ['RevenueCat', /^REVENUECAT_/],
      ['Mailgun', /^MAILGUN_/],
      ['Resend', /^RESEND_/],
      ['SMTP', /^EMAIL_PASS$/],
      ['Cloudflare R2', /^CLOUDFLARE_/],
      ['OpenAI', /^OPENAI_/],
      ['fal', /^FAL_KEY$/],
      ['ElevenLabs', /^ELEVENSLABS_/],
      ['Evolink', /^EVOLINK_/],
      ['Deepgram', /^DEEPGRAM_/],
      ['Meta Muse', /^META_MUSE_/],
      ['Tavily', /^TAVILY_/],
      ['RunPod', /^RUNPOD_/],
      ['Transloadit', /^TRANSLOADIT_/],
      ['Dub', /^DUB_/],
      ['Kutt', /^KUTT_/],
      ['LinkDrip', /^LINK_DRIP_/],
      ['Short.io', /^SHORT_IO_/],
      ['Beehiiv', /^BEEHIIVE_/],
      ['Listmonk', /^LISTMONK_/],
      ['Sentry', /SENTRY_DSN$/],
      ['PostHog', /POSTHOG_KEY$/],
      ['Google Tag Manager', /^NEXT_PUBLIC_GTM_ID$/],
      ['Meta Pixel', /FACEBOOK_PIXEL/],
      ['DataFast', /^DATAFAST_/],
      ['Google reCAPTCHA', /^RECAPTCHA_/],
      ['Chatbase', /^CHATBASE_/],
      ['Polotno', /POLOTNO$/],
      ['Agent Media', /^AGENT_MEDIA_SSO_KEY$/],
      ['GitHub', /^GITHUB_CLIENT_SECRET$/],
      ['Neynar', /^NEYNAR_/],
      ['OpenID', /GENERIC_OAUTH|POSTIZ_OAUTH/],
    ];

    // Secret-like keys that are not a third party receiving user data: this deployment's own
    // credentials, and the social platforms the page names as "social platforms you connect".
    const NOT_A_THIRD_PARTY =
      /^(JWT_SECRET|AGENT_API_KEY|TEMPORAL_API_KEY|(DISCORD|DRIBBBLE|FACEBOOK_APP|GOOGLE_GMB|INSTAGRAM|KICK|LINKEDIN|MASTODON|MEWE|PINTEREST|REDDIT|SLACK|TELEGRAM|THREADS|TIKTOK|TIKTOK_BUSINESS|TUMBLR|TWITCH|X_API|YOUTUBE)_[A-Z_]*)$/;

    it('every service the privacy page names is a whole word on the page and called by the code', () => {
      const code = filesWhere(() => true).map(([, text]) => text).join('\n');
      const privacy = page('privacy');
      for (const [name, evidence] of SERVICES) {
        expect(named(privacy, name)).toBe(true);
        const keys = [...code.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
        expect(keys.some((key) => evidence.test(key))).toBe(true);
      }
    });

    it('every secret-like env key the code reads belongs to a named service or is not a third party', () => {
      const keyed = new Set<string>();
      for (const [path, text] of filesWhere((p) => !/[\\/]sdk[\\/]/.test(p))) {
        for (const match of text.matchAll(/process\.env\.([A-Z0-9_]*(?:KEY|TOKEN|SECRET|AUTH|DSN|PIXEL|WEBSITE_ID|POLOTNO|PASS|OAUTH)[A-Z0-9_]*)\b/g)) {
          keyed.add(match[1]);
        }
      }
      const unlisted = [...keyed]
        .filter((key) => !NOT_A_THIRD_PARTY.test(key))
        .filter((key) => !SERVICES.some(([, evidence]) => evidence.test(key)))
        .sort();
      expect(unlisted).toEqual([]);
    });

    // Every host the non-social code calls, and the name the privacy page gives it ('' = not a
    // third party that receives user data from this deployment: a doc link, a placeholder, a test host,
    // or a host reached only when the app runs in development).
    const HOSTS: Record<string, string> = {
      'agent-media.ai': 'Agent Media',
      'api.beehiiv.com': 'Beehiiv',
      'api.deepgram.com': 'Deepgram',
      'api.dub.co': 'Dub',
      'api.elevenlabs.io': 'ElevenLabs',
      'api.eu.mailgun.net': 'Mailgun',
      'api.mailgun.net': 'Mailgun',
      'api.evolink.ai': 'Evolink',
      'api.github.com': 'GitHub',
      'github.com': 'GitHub',
      'api.heygen.com': 'HeyGen',
      'api.linkdrip.com': 'LinkDrip',
      'api.meta.ai': 'Meta Muse',
      'api.revenuecat.com': 'RevenueCat',
      'api.runpod.ai': 'RunPod',
      'api.short.io': 'Short.io',
      'statistics.short.io': 'Short.io',
      'appleid.apple.com': 'Apple',
      'datafa.st': 'DataFast',
      'fal.run': 'fal',
      'kutt.it': 'Kutt',
      'reel.farm': 'ReelFarm',
      'www.chatbase.co': 'Chatbase',
      'www.googleapis.com': 'Google',
      'www.google.com': 'Google reCAPTCHA',
      // Apple sign-in redirect helper, used only when the app is not on its production domain.
      'redirectmeto.com': '',
      // Meta's developer docs, linked from a comment of the Muse transcription service.
      'dev.meta.ai': '',
      'example.com': '',
      'facebook.com': '',
      'modelcontextprotocol.io': '',
      'nextjs.org': '',
      'paypal.invalid': '',
      'via.placeholder.com': '',
      'www.linkedin.com': '',
      'www.rfc-editor.org': '',
      'www.skool.com': '',
      'www.tiktok.com': '',
      'www.w3.org': '',
      'x.com': '',
      'yourapp.com': '',
    };

    it('every host the code calls outside the social providers is mapped, and named on the page', () => {
      const files = filesWhere((path) => !/[\\/](sdk|social)[\\/]|\.tags\.ts$/.test(path));
      const hosts = new Set<string>();
      for (const [, text] of files) {
        for (const match of text.matchAll(/https?:\/\/([a-zA-Z0-9.-]+\.[a-z]{2,})/g)) {
          hosts.add(match[1]);
        }
      }
      expect([...hosts].filter((host) => !(host in HOSTS)).sort()).toEqual([]);
      const privacy = page('privacy');
      const unnamed = [...hosts]
        .map((host) => HOSTS[host])
        .filter((name) => name && !named(privacy, name));
      expect(unnamed).toEqual([]);
    });

    // The packages that open their own connections (a library calls its vendor without a literal
    // host or env key in this repo), with the name the page gives each. '' = no user data leaves:
    // the social platforms (named as such), this deployment's own services, or local-only code.
    const PACKAGES: Record<string, string> = {
      polotno: 'Polotno',
      '@copilotkit/runtime': 'CopilotKit',
      '@copilotkit/react-core': 'CopilotKit',
      '@copilotkit/react-textarea': 'CopilotKit',
      '@copilotkit/react-ui': 'CopilotKit',
      '@copilotkit/runtime-client-gql': 'CopilotKit',
      '@sentry/nextjs': 'Sentry',
      '@sentry/nestjs': 'Sentry',
      '@sentry/react': 'Sentry',
      '@sentry/profiling-node': 'Sentry',
      'posthog-js': 'PostHog',
      resend: 'Resend',
      nodemailer: 'SMTP',
      '@aws-sdk/client-s3': 'Cloudflare R2',
      '@aws-sdk/lib-storage': 'Cloudflare R2',
      '@aws-sdk/s3-request-presigner': 'Cloudflare R2',
      '@uppy/aws-s3': 'Cloudflare R2',
      openai: 'OpenAI',
      '@ai-sdk/openai': 'OpenAI',
      '@langchain/openai': 'OpenAI',
      '@langchain/tavily': 'Tavily',
      '@langchain/community': 'Tavily',
      '@neynar/nodejs-sdk': 'Neynar',
      'facebook-nodejs-business-sdk': 'Meta Pixel',
      transloadit: 'Transloadit',
      '@uppy/transloadit': 'Transloadit',
      'google-auth-library': 'Google',
      googleapis: 'Google',
      '@dub/analytics': 'Dub',
      '@solana/wallet-adapter-react': 'wallet',
      '@solana/wallet-adapter-react-ui': 'wallet',
      '@postiz/wallets': 'wallet',
      '@atproto/api': '',
      'node-telegram-bot-api': '',
      'twitter-api-v2': '',
      '@types/facebook-nodejs-business-sdk': '',
      '@types/nodemailer': '',
      '@types/node-telegram-bot-api': '',
      '@modelcontextprotocol/sdk': '',
      '@mastra/mcp': '',
      '@langchain/core': '',
      '@langchain/langgraph': '',
      '@prisma/client': '',
      '@temporalio/activity': '',
      '@temporalio/client': '',
      '@temporalio/common': '',
      '@temporalio/worker': '',
      '@temporalio/workflow': '',
      'nestjs-temporal-core': '',
      '@uppy/compressor': '',
      '@uppy/core': '',
      '@uppy/dashboard': '',
      '@uppy/drag-drop': '',
      '@uppy/file-input': '',
      '@uppy/progress-bar': '',
      '@uppy/react': '',
      '@uppy/status-bar': '',
      '@uppy/xhr-upload': '',
      'music-metadata': '',
      'reflect-metadata': '',
    };

    it('every dependency that can open its own connection is mapped, and its service is named on the page', () => {
      const manifest = JSON.parse(read('package.json'));
      const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
      const looksConnecting =
        /sdk|client|api|analytics|sentry|posthog|telemetry|copilot|polotno|openai|aws|google|facebook|mailer|resend|wallet|solana|uppy|langchain|neynar|dub|transloadit|nodemailer|temporal|atproto/i;
      const unmapped = deps.filter((dep) => looksConnecting.test(dep) && !(dep in PACKAGES)).sort();
      expect(unmapped).toEqual([]);
      const privacy = page('privacy');
      const unnamed = deps
        .map((dep) => PACKAGES[dep])
        .filter((name) => name && !named(privacy, name));
      expect(unnamed).toEqual([]);
    });

    // Provider implementations that are registered by file, with the name the page gives each.
    const PROVIDERS: Record<string, string> = {
      'payment/providers/paypal.provider': 'PayPal',
      'payment/providers/revenuecat.provider': 'RevenueCat',
      'emails/mailgun.provider': 'Mailgun',
      'emails/resend.provider': 'Resend',
      'emails/node.mailer.provider': 'SMTP',
      'emails/log.provider': '',
      'emails/empty.provider': '',
      'newsletter/providers/beehiiv.provider': 'Beehiiv',
      'newsletter/providers/listmonk.provider': 'Listmonk',
      'newsletter/providers/email-empty.provider': '',
      'short-linking/providers/dub': 'Dub',
      'short-linking/providers/kutt': 'Kutt',
      'short-linking/providers/linkdrip': 'LinkDrip',
      'short-linking/providers/short.io': 'Short.io',
      'short-linking/providers/empty': '',
      '3rdparties/heygen/heygen.provider': 'HeyGen',
      '3rdparties/reelfarm/reelfarm.provider': 'ReelFarm',
      'auth/providers/apple.provider': 'Apple',
      'auth/providers/farcaster.provider': 'Farcaster',
      'auth/providers/github.provider': 'GitHub',
      'auth/providers/google.provider': 'Google',
      'auth/providers/oauth.provider': 'OpenID',
      'auth/providers/wallet.provider': 'wallet',
    };

    it('every registered payment, mail, newsletter, short-link, media-tool and sign-in provider is mapped, and named on the page', () => {
      const dirs = /(payment[\\/]providers|emails|newsletter[\\/]providers|short-linking[\\/]providers|3rdparties[\\/][a-z]+|auth[\\/]providers)[\\/][^\\/]+\.ts$/;
      const found = filesWhere((path) => dirs.test(path) && !/(interface|manager|abstract)/.test(path))
        .map(([path]) => path.replace(/\\/g, '/'))
        .map((path) => path.replace(/^.*\/(payment\/providers|emails|newsletter\/providers|short-linking\/providers|3rdparties\/[a-z]+|auth\/providers)\//, '$1/').replace(/\.ts$/, ''));
      // The scan must really find the provider folders, or an empty result would pass.
      expect(found.length).toBe(Object.keys(PROVIDERS).length);
      expect(found.filter((key) => !(key in PROVIDERS)).sort()).toEqual([]);
      const privacy = page('privacy');
      const unnamed = found
        .map((key) => PROVIDERS[key])
        .filter((name) => name && !named(privacy, name));
      expect(unnamed).toEqual([]);
    });
  });

  describe('the data-deletion page describes what POST /delete-account does', () => {
    // Reads the field names of the `data: { ... }` block that follows `marker` in a repo source file.
    const fieldsSet = (file: string, marker: string): string[] => {
      const source = read(file);
      const from = source.indexOf(marker);
      expect(from).toBeGreaterThan(-1);
      const open = source.indexOf('data: {', from);
      const close = source.indexOf('\n      },', open);
      return [...source.slice(open + 7, close).matchAll(/^\s{8}([A-Za-z]+):/gm)].map((m) => m[1]);
    };
    const DB = 'libraries/nestjs-libraries/src/database/prisma';

    it('the user row fields the action changes are the ones the page describes', () => {
      expect(fieldsSet(`${DB}/users/users.repository.ts`, 'async deleteAccount(userId')).toEqual([
        'email', 'password', 'name', 'lastName', 'providerId', 'bio', 'ip', 'agent', 'account', 'pictureId', 'deletedAt',
      ]);
      const deletion = page('data-deletion');
      for (const claim of [/email address/, /profile text/, /IP address/, /browser string/, /picture/, /provider id/]) {
        expect(deletion).toMatch(claim);
      }
    });

    it('the channel fields the action changes are the ones the page describes', () => {
      const source = read(`${DB}/integrations/integration.repository.ts`);
      const from = source.indexOf('async deleteIntegrationsForAccount(');
      expect(from).toBeGreaterThan(-1);
      const body = source.slice(from, source.indexOf('\n  async ', from + 10));
      const fields = [...body.matchAll(/^\s+([A-Za-z]+):/gm)].map((m) => m[1]);
      for (const field of ['name', 'internalId', 'token', 'refreshToken', 'profile', 'picture', 'deletedAt']) {
        expect(fields).toContain(field);
      }
      const deletion = page('data-deletion');
      expect(deletion).toMatch(/access tokens/);
      expect(deletion).toMatch(/replaced by a hash/);
      expect(deletion).toMatch(/pictures are removed/);
    });

    it('does not claim more than the action does', () => {
      const deletion = page('data-deletion');
      expect(deletion).not.toMatch(/no longer be tied|permanently|completely|all your data/i);
      expect(deletion).toMatch(/not removed by this action/);
      expect(deletion).toMatch(/cancel it in the app store/);
    });
  });
});
