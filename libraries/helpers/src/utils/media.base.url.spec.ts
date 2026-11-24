// Feature: media-publish-url. The one media base URL (CLOUDFLARE_BUCKET_URL) and the rebase of stored
// URLs after it changes. Run from the repo root:
//   npx jest -c libraries/nestjs-libraries/jest.config.cjs --roots '<rootDir>/libraries/helpers/src' media.base.url
import {
  mediaBaseUrl,
  mediaUrl,
  rebaseMediaUrls,
} from '@gitroom/helpers/utils/media.base.url';

describe('media base URL', () => {
  const saved = process.env.CLOUDFLARE_BUCKET_URL;
  afterEach(() => {
    process.env.CLOUDFLARE_BUCKET_URL = saved;
  });

  it('is CLOUDFLARE_BUCKET_URL without a trailing slash', () => {
    process.env.CLOUDFLARE_BUCKET_URL = 'https://cdn.nanybot.com/nany-social/';
    expect(mediaBaseUrl()).toBe('https://cdn.nanybot.com/nany-social');
    expect(mediaUrl('a1.mp4')).toBe(
      'https://cdn.nanybot.com/nany-social/a1.mp4'
    );
  });

  it('is the value as set when it has no trailing slash', () => {
    process.env.CLOUDFLARE_BUCKET_URL = 'https://cdn.nanybot.com/nany-social';
    expect(mediaUrl('a1.mp4')).toBe(
      'https://cdn.nanybot.com/nany-social/a1.mp4'
    );
  });
});

describe('rebaseMediaUrls', () => {
  const OLD = 'https://pub-123.r2.dev';
  const NEW = 'https://cdn.nanybot.com/nany-social';

  it('moves a plain URL to the new base', () => {
    expect(rebaseMediaUrls(`${OLD}/a1.mp4`, [OLD], NEW)).toBe(`${NEW}/a1.mp4`);
  });

  it('moves every URL inside a JSON text', () => {
    const json = JSON.stringify([
      { id: '1', path: `${OLD}/a.png` },
      { id: '2', path: `${OLD}/b.mp4`, thumbnail: `${OLD}/b.jpg` },
    ]);
    const out = JSON.parse(rebaseMediaUrls(json, [OLD], NEW));
    expect(out.map((i: any) => i.path)).toEqual([
      `${NEW}/a.png`,
      `${NEW}/b.mp4`,
    ]);
    expect(out[1].thumbnail).toBe(`${NEW}/b.jpg`);
  });

  it('leaves a URL on another host, and a host that only starts like the old one', () => {
    const text = `https://example.com/a.png ${OLD}.evil.com/x.png`;
    expect(rebaseMediaUrls(text, [OLD], NEW)).toBe(text);
  });

  it('is a no-op when the text is already on the new base or from equals to', () => {
    expect(rebaseMediaUrls(`${NEW}/a.png`, [OLD], NEW)).toBe(`${NEW}/a.png`);
    expect(rebaseMediaUrls(`${OLD}/a.png`, [OLD], OLD)).toBe(`${OLD}/a.png`);
  });

  it('is idempotent when the new base starts with an old one', () => {
    const from = 'https://cdn.nanybot.com';
    const once = rebaseMediaUrls(`${from}/a.png`, [from], NEW);
    expect(once).toBe(`${NEW}/a.png`);
    expect(rebaseMediaUrls(once, [from], NEW)).toBe(`${NEW}/a.png`);
  });

  it('accepts several old bases and ignores trailing slashes', () => {
    const text = `https://x.r2.cloudflarestorage.com/a.png ${OLD}/b.png`;
    expect(
      rebaseMediaUrls(
        text,
        ['https://x.r2.cloudflarestorage.com/', OLD],
        `${NEW}/`
      )
    ).toBe(`${NEW}/a.png ${NEW}/b.png`);
  });
});
