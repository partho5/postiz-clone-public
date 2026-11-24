// Feature: media-publish-url. The configuration check of the one media base URL. Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/libraries/helpers/src' configuration.checker
import { ConfigurationChecker } from '@gitroom/helpers/configuration/configuration.checker';

// The issues the media base URL check reports for an environment.
const issuesFor = (env: Record<string, string>) => {
  const checker = new ConfigurationChecker();
  checker.cfg = env as any;
  checker.checkMediaBaseUrl();
  return checker.getIssues();
};

describe('media base URL configuration', () => {
  const good = {
    STORAGE_PROVIDER: 'cloudflare',
    CLOUDFLARE_BUCKET_URL: 'https://cdn.nanybot.com/nany-social',
    RESTRICT_UPLOAD_DOMAINS: 'cdn.nanybot.com',
  };

  it('accepts a public https base that RESTRICT_UPLOAD_DOMAINS names', () => {
    expect(issuesFor(good)).toEqual([]);
  });

  it('is not checked on local storage', () => {
    expect(issuesFor({ STORAGE_PROVIDER: 'local' })).toEqual([]);
  });

  it('reports a missing base, a trailing slash and a non https base', () => {
    expect(issuesFor({ STORAGE_PROVIDER: 'cloudflare' })).toHaveLength(1);
    expect(
      issuesFor({
        ...good,
        CLOUDFLARE_BUCKET_URL: 'https://cdn.nanybot.com/x/',
      })
    ).toEqual(['CLOUDFLARE_BUCKET_URL should not end with /']);
    expect(
      issuesFor({
        ...good,
        CLOUDFLARE_BUCKET_URL: 'http://cdn.nanybot.com/nany-social',
      })
    ).toEqual(['CLOUDFLARE_BUCKET_URL must start with https://']);
  });

  it('reports the private R2 endpoint', () => {
    expect(
      issuesFor({
        ...good,
        CLOUDFLARE_BUCKET_URL: 'https://acc.r2.cloudflarestorage.com/b',
        RESTRICT_UPLOAD_DOMAINS: 'r2.cloudflarestorage.com',
      })
    ).toHaveLength(1);
  });

  it('reports a RESTRICT_UPLOAD_DOMAINS that is not the base host', () => {
    expect(
      issuesFor({ ...good, RESTRICT_UPLOAD_DOMAINS: 'other.example.com' })
    ).toEqual([
      'RESTRICT_UPLOAD_DOMAINS must name the host of CLOUDFLARE_BUCKET_URL',
    ]);
  });
});
