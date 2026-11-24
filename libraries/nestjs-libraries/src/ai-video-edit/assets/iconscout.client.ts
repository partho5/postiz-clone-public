// AI video editing (ai.video-editing), assets (spec section 15): the calls to the IconScout API v3. Nothing here knows
// the planner or the storage: it searches a query for one kind of file and downloads one hit. The shapes of IconScout's
// answers are read in `readHits` alone. The Client-ID stays on the server.
import { Injectable } from '@nestjs/common';
import { MAX_ICON_BYTES, MAX_VIDEO_BYTES } from './edit.asset.files';

// The kinds of file the plan can show: an animated mp4 clip or a still icon image (PNG).
export type AssetKind = 'video' | 'icon';

// One search result: the provider's id (its uuid), the url of the file in the search answer and what the answer says
// about the item (its name is what the picker reads).
export interface IconscoutHit {
  id: string;
  kind: AssetKind;
  url: string;
  name: string;
  slug?: string;
  price?: number;
  colorCodes?: unknown[];
}

// A call that failed or answered something unusable. The resolver drops the slot on it, so it carries no customer text.
export class IconscoutError extends Error {}

const API = 'https://api.iconscout.com/v3';

// How long one call may take, and how many hits a search asks for (the model picks one by name; only that hit is downloaded).
const CALL_TIMEOUT_MS = 20_000;
const PER_PAGE = 10;

// The url keys of an item that hold a PNG, largest first.
const PNG_KEYS = ['png_512', 'png_256', 'png_128', 'png'];

// The path of a url without its query, lower case, to read the file type from.
const pathOf = (url: string) => url.split(/[?#]/)[0].toLowerCase();

// The file url of one search item for a kind: the `thumb` mp4 preview, or a PNG (the keys named above first). The
// item's `urls` is a map of names to urls; a field that is not a url is ignored.
const fileUrl = (item: any, kind: AssetKind): string | undefined => {
  const urls: Record<string, unknown> = item?.urls && typeof item.urls === 'object' ? item.urls : {};
  const entries = Object.entries(urls).filter(
    (e): e is [string, string] => typeof e[1] === 'string' && /^https:\/\//i.test(e[1])
  );
  if (kind === 'video') {
    return entries.find(([k, url]) => k === 'thumb' && pathOf(url).endsWith('.mp4'))?.[1];
  }
  for (const key of PNG_KEYS) {
    const hit = entries.find(([k, url]) => k === key && pathOf(url).endsWith('.png'));
    if (hit) return hit[1];
  }
  return entries.find(([, url]) => pathOf(url).endsWith('.png'))?.[1];
};

// The hits of a search answer: `response.items.data` (a list), each item with its `uuid`, its `name` and a file url
// for the kind. An item missing any of them is skipped; an answer that is not a list has no hits.
export const readHits = (json: any, kind: AssetKind): IconscoutHit[] => {
  const items = json?.response?.items;
  const list: any[] = Array.isArray(items?.data) ? items.data : Array.isArray(items) ? items : [];
  const hits: IconscoutHit[] = [];
  for (const item of list) {
    const id = typeof item?.uuid === 'string' ? item.uuid.trim() : '';
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const url = fileUrl(item, kind);
    if (!id || !name || !url) continue;
    hits.push({
      id,
      kind,
      url,
      name,
      ...(typeof item.slug === 'string' && item.slug ? { slug: item.slug } : {}),
      ...(typeof item.price === 'number' && Number.isFinite(item.price) ? { price: Math.round(item.price) } : {}),
      ...(Array.isArray(item.color_codes) ? { colorCodes: item.color_codes } : {}),
    });
  }
  return hits;
};

@Injectable()
export class IconscoutClient {
  // The network call: the global fetch (a test sets another).
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  // Whether the Client-ID is set; without it no icon is searched.
  isConfigured() {
    return !!process.env.ICONSCOUT_CLIENT_ID;
  }

  // Searches a query for a kind of file; the best hits first. Throws IconscoutError on a refusal, a timeout or an
  // answer that is not one.
  async search(query: string, kind: AssetKind): Promise<IconscoutHit[]> {
    const params = new URLSearchParams({
      query,
      product_type: 'item',
      // IconScout's word for its animated items; the `urls.thumb` of each is an mp4 preview
      asset: kind === 'video' ? 'lottie' : 'icon',
      per_page: String(PER_PAGE),
      page: '1',
    });
    const response = await this.call(`${API}/search?${params}`, {
      method: 'GET',
      headers: { 'Client-ID': process.env.ICONSCOUT_CLIENT_ID! },
    });
    return readHits(await this.json(response), kind);
  }

  // Downloads the file of a hit: the url of the search answer, fetched directly (no key, no credits). Throws
  // IconscoutError when the file cannot be had or is larger than an overlay file.
  async download(hit: IconscoutHit): Promise<Buffer> {
    const response = await this.call(hit.url, { method: 'GET' });
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > (hit.kind === 'video' ? MAX_VIDEO_BYTES : MAX_ICON_BYTES)) {
      throw new IconscoutError('The file is larger than an overlay file');
    }
    return data;
  }

  // One call with a timeout; the error names no url or body, only that the call failed.
  private async call(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    } catch (err) {
      throw new IconscoutError(`The call did not complete (${(err as Error).name})`);
    }
    if (!response.ok) {
      throw new IconscoutError(`IconScout answered ${response.status}`);
    }
    return response;
  }

  // The JSON of an answer; anything else is not an answer.
  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new IconscoutError('The answer is not JSON');
    }
  }
}
