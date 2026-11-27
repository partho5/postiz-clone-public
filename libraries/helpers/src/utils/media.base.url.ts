// Feature: media-publish-url. CLOUDFLARE_BUCKET_URL is the only place the public media host is
// defined; every stored media URL is this base plus the object key, and a changed base is rebased
// onto stored URLs by the media:rebase-urls command.

// The public media base URL without a trailing slash; the one read of CLOUDFLARE_BUCKET_URL.
// An unset value gives '' (so `mediaUrl('k')` is `/k`) and does not throw, request paths must keep
// answering; the missing value is reported at start-up by `config:check`
// (`ConfigurationChecker.checkMediaBaseUrl`, cloud storage only).
export const mediaBaseUrl = (): string =>
  (process.env.CLOUDFLARE_BUCKET_URL || '').replace(/\/+$/, '');

// The public URL of an object key in the media bucket.
export const mediaUrl = (key: string): string => `${mediaBaseUrl()}/${key}`;

// Escapes a text for use inside a regular expression.
const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Replaces every old base URL (`from`) found in a text with `to`; one pass, and a URL already on
// `to` is left alone even when `to` starts with a `from`. Only whole prefixes (`<from>/`) match.
export const rebaseMediaUrls = (
  text: string,
  from: string[],
  to: string
): string => {
  const target = to.replace(/\/+$/, '');
  const patterns = from
    .map((base) => base.replace(/\/+$/, ''))
    .filter((base) => base && base !== target)
    .sort((a, b) => b.length - a.length)
    .map((base) => {
      const done = target.startsWith(`${base}/`)
        ? `(?!${escapeRegExp(target.slice(base.length + 1))}/)`
        : '';
      return `${escapeRegExp(base)}/${done}`;
    });
  if (!patterns.length) {
    return text;
  }
  return text.replace(
    new RegExp(`(?:${patterns.join('|')})`, 'g'),
    () => `${target}/`
  );
};
