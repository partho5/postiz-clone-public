// api.mobile-direct-upload (DU-B4): only POST /public/v1/upload/multipart joins the public API throttle
// under the workspace's own `upload` bucket (`upload_audio` for a caption audio, ai.video-captions). Runs on
// hand-made requests, so it needs no Redis or database.
import { ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerBehindProxyGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';

describe('ThrottlerBehindProxyGuard: upload bucket', () => {
  const guard = Object.create(ThrottlerBehindProxyGuard.prototype) as any;
  let counted: jest.SpyInstance;

  // The execution context of a request to the url.
  const contextOf = (method: string, url: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ method, url }) }),
    } as any);

  beforeEach(() => {
    counted = jest
      .spyOn(ThrottlerGuard.prototype, 'canActivate')
      .mockResolvedValue(true);
  });

  afterEach(() => {
    counted.mockRestore();
  });

  it('counts the request that creates an upload', async () => {
    await guard.canActivate(contextOf('POST', '/public/v1/upload/multipart'));

    expect(counted).toHaveBeenCalledTimes(1);
  });

  it('does not count parts, status, complete, abort or the plain upload', async () => {
    const requests: Array<[string, string]> = [
      ['POST', '/public/v1/upload'],
      ['POST', '/public/v1/upload/multipart/up-1/parts'],
      ['GET', '/public/v1/upload/multipart/up-1'],
      ['POST', '/public/v1/upload/multipart/up-1/complete'],
      ['DELETE', '/public/v1/upload/multipart/up-1'],
      ['GET', '/public/v1/upload/multipart'],
    ];

    for (const [method, url] of requests) {
      await expect(guard.canActivate(contextOf(method, url))).resolves.toBe(
        true
      );
    }
    expect(counted).not.toHaveBeenCalled();
  });

  it('keys the create request by workspace and bucket `upload`, apart from posts and other', async () => {
    const keyOf = (method: string, url: string) =>
      guard.getTracker({ org: { id: 'org-1' }, method, url, headers: {} });

    await expect(
      keyOf('POST', '/public/v1/upload/multipart')
    ).resolves.toBe('org-1_upload');
    await expect(
      keyOf('POST', '/public/v1/upload/multipart?x=1')
    ).resolves.toBe('org-1_upload');
    await expect(keyOf('POST', '/public/v1/upload')).resolves.toBe(
      'org-1_other'
    );
    await expect(
      keyOf('POST', '/public/v1/upload/multipart/up-1/parts')
    ).resolves.toBe('org-1_other');
    await expect(keyOf('POST', '/public/v1/posts')).resolves.toBe('org-1_posts');
  });

  it('keys the caption audio request by its own bucket `upload_audio`, so video uploads never use it up', async () => {
    const keyOf = (body?: unknown) =>
      guard.getTracker({
        org: { id: 'org-1' },
        method: 'POST',
        url: '/public/v1/upload/multipart',
        headers: {},
        body,
      });

    await expect(
      keyOf({ filename: 'a.wav', size: 1, purpose: 'transcript_audio' })
    ).resolves.toBe('org-1_upload_audio');
    // ai.video-editing: an edit proxy counts in the same bucket as the caption audio
    await expect(
      keyOf({ filename: 'p.mp4', size: 1, purpose: 'edit_proxy' })
    ).resolves.toBe('org-1_upload_audio');
    await expect(
      keyOf({ filename: 'a.mp4', size: 1, purpose: 'media' })
    ).resolves.toBe('org-1_upload');
    await expect(keyOf({ filename: 'a.mp4', size: 1 })).resolves.toBe(
      'org-1_upload'
    );
    await expect(keyOf(undefined)).resolves.toBe('org-1_upload');
  });
});

// Content plan: POST and PUT under /content-plan join the throttle under the workspace's own `content_plan` bucket;
// reads and every other route are not counted by it.
describe('ThrottlerBehindProxyGuard: content plan bucket', () => {
  const guard = Object.create(ThrottlerBehindProxyGuard.prototype) as any;
  let counted: jest.SpyInstance;

  const contextOf = (method: string, url: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ method, url }) }),
    } as any);

  beforeEach(() => {
    counted = jest
      .spyOn(ThrottlerGuard.prototype, 'canActivate')
      .mockResolvedValue(true);
  });

  afterEach(() => {
    counted.mockRestore();
  });

  it('counts a POST or PUT under /content-plan', async () => {
    await guard.canActivate(contextOf('POST', '/content-plan/setup/start'));
    await guard.canActivate(contextOf('PUT', '/content-plan/direction'));
    await guard.canActivate(contextOf('POST', '/content-plan?x=1'));

    expect(counted).toHaveBeenCalledTimes(3);
  });

  it('does not count a GET, or a path that only starts with the same letters', async () => {
    const requests: Array<[string, string]> = [
      ['GET', '/content-plan'],
      ['GET', '/content-plan/weeks/current'],
      ['POST', '/content-planner'],
      ['POST', '/public/v1/content-plan/days/d-1/recorded'],
    ];

    for (const [method, url] of requests) {
      await expect(guard.canActivate(contextOf(method, url))).resolves.toBe(
        true
      );
    }
    expect(counted).not.toHaveBeenCalled();
  });

  it('keys the writes by workspace and bucket `content_plan`', async () => {
    const keyOf = (method: string, url: string) =>
      guard.getTracker({ org: { id: 'org-1' }, method, url, headers: {} });

    await expect(keyOf('POST', '/content-plan/proposal')).resolves.toBe(
      'org-1_content_plan'
    );
    await expect(keyOf('PUT', '/content-plan/facts')).resolves.toBe(
      'org-1_content_plan'
    );
    await expect(keyOf('GET', '/content-plan')).resolves.toBe('org-1_other');
  });
});
