// Pass-through to Meta's Model API, run in a region Meta serves. The caller's own Authorization header is forwarded;
// RELAY_TOKEN only stops strangers using this URL as an open proxy.
const UPSTREAM = 'https://api.meta.ai/v1/';
const FORWARD = ['authorization', 'content-type', 'accept', 'openai-organization', 'openai-project'];

export default {
  async fetch(request) {
    if (request.headers.get('x-relay-token') !== process.env.RELAY_TOKEN) {
      return new Response('forbidden', { status: 403 });
    }
    const path = new URL(request.url).searchParams.get('p') ?? '';
    const headers = new Headers();
    for (const name of FORWARD) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    const upstream = await fetch(UPSTREAM + path, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      duplex: 'half',
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  },
};
