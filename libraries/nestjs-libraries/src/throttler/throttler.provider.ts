import { ThrottlerGuard } from '@nestjs/throttler';
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import {
  MOBILE_UPLOAD_PURPOSE_AUDIO,
  MOBILE_UPLOAD_PURPOSE_EDIT_PROXY,
} from '@gitroom/nestjs-libraries/dtos/mobile-upload/mobile.upload.create.dto';

const isPublicComment = (method: string, url: string) =>
  method === 'POST' && /^\/public\/posts\/[^/]+\/comments/.test(url);

// A request that creates posts through the public API: POST /posts, and POST /auto-publish which
// runs the same creation path.
const isPublicPostCreation = (method: string, url: string) =>
  method === 'POST' &&
  (url.includes('/public/v1/posts') || url.includes('/public/v1/auto-publish'));

// A request that opens a phone's direct upload: POST /upload/multipart only (not its parts, status,
// complete or abort, and not POST /upload).
const isPublicUploadCreation = (method: string, url: string) =>
  method === 'POST' && /^\/public\/v1\/upload\/multipart\/?(\?|$)/.test(url);

// A request for a one-time web sign-in link from the app: POST /web-link.
const isPublicWebLink = (method: string, url: string) =>
  method === 'POST' && /^\/public\/v1\/web-link\/?(\?|$)/.test(url);

// A write of the content plan: POST or PUT under /content-plan. Reads (GET) are not limited.
const isContentPlanWrite = (method: string, url: string) =>
  (method === 'POST' || method === 'PUT') && /^\/content-plan(\/|\?|$)/.test(url);

@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  public override async canActivate(
    context: ExecutionContext
  ): Promise<boolean> {
    const { url, method } = context.switchToHttp().getRequest<Request>();
    if (
      isPublicPostCreation(method, url) ||
      isPublicComment(method, url) ||
      isPublicUploadCreation(method, url) ||
      isPublicWebLink(method, url) ||
      isContentPlanWrite(method, url)
    ) {
      return super.canActivate(context);
    }

    return true;
  }

  protected override async getTracker(
    req: Record<string, any>
  ): Promise<string> {
    if (!req.org) {
      const forwarded = String(req.headers?.['x-forwarded-for'] || '')
        .split(',')[0]
        .trim();
      return 'ip_' + (forwarded || req.ip || 'unknown');
    }

    if (isPublicUploadCreation(req.method, req.url)) {
      // The work files of AI jobs (a caption job's speech audio, an edit job's proxy videos) count in their own
      // bucket, so they never use up the video uploads
      return (
        req.org.id +
        (req.body?.purpose === MOBILE_UPLOAD_PURPOSE_AUDIO ||
        req.body?.purpose === MOBILE_UPLOAD_PURPOSE_EDIT_PROXY
          ? '_upload_audio'
          : '_upload')
      );
    }

    if (isPublicWebLink(req.method, req.url)) {
      return req.org.id + '_web_link';
    }

    if (isContentPlanWrite(req.method, req.url)) {
      // The planner's writes count in a bucket of their own, so they never use up the posts limit
      return req.org.id + '_content_plan';
    }

    return (
      req.org.id +
      '_' +
      (req.url.indexOf('/posts') > -1 || req.url.indexOf('/auto-publish') > -1
        ? 'posts'
        : 'other')
    );
  }
}

// route-level guard for public endpoints, keyed by the client address the
// proxy forwards rather than the org the global guard expects
@Injectable()
export class ThrottlerRealIpGuard extends ThrottlerGuard {
  protected override async getTracker(
    req: Record<string, any>
  ): Promise<string> {
    const forwarded = String(req.headers?.['x-forwarded-for'] || '');
    return forwarded.split(',')[0].trim() || req.ip;
  }
}
