// PayPal REST client: the one authenticated way the server calls PayPal, and the
// check that a webhook really came from PayPal. No business logic lives here.
import { Injectable, Logger } from '@nestjs/common';
import { timer } from '@gitroom/helpers/utils/timer';

// Access tokens are dropped this long before PayPal says they expire.
const TOKEN_SKEW_MS = 60_000;
// One call to PayPal is abandoned after this long and counts as unreachable.
const REQUEST_TIMEOUT_MS = 30_000;
// Retries after the first attempt, and the wait before the first retry (it grows per retry).
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 200;

const VERIFY_PATH = '/v1/notifications/verify-webhook-signature';
// The REST API of each PAYPAL_MODE; PAYPAL_API_BASE, when set, overrides it.
const MODE_BASES: Record<string, string> = {
  live: 'https://api-m.paypal.com',
  sandbox: 'https://api-m.sandbox.paypal.com',
};
// The config keys that must be set, with the env var each comes from (named in the not-configured log).
const CREDENTIAL_VARS = [
  ['clientId', 'PAYPAL_CLIENT_ID'],
  ['clientSecret', 'PAYPAL_CLIENT_SECRET'],
  ['webhookId', 'PAYPAL_WEBHOOK_ID'],
] as const;
// The transmission headers PayPal signs a webhook with, in the order the verify call names them.
const TRANSMISSION_HEADERS = [
  ['auth_algo', 'paypal-auth-algo'],
  ['cert_url', 'paypal-cert-url'],
  ['transmission_id', 'paypal-transmission-id'],
  ['transmission_sig', 'paypal-transmission-sig'],
  ['transmission_time', 'paypal-transmission-time'],
] as const;

type Headers = Record<string, string | string[] | undefined>;

// Thrown when a call is made while PayPal is not configured (a missing var or an unknown PAYPAL_MODE).
export class PaypalNotConfiguredError extends Error {
  constructor() {
    super('PayPal is not configured');
    this.name = 'PaypalNotConfiguredError';
  }
}

// Thrown when PayPal answered a call with a non-2xx status.
export class PaypalApiError extends Error {
  status: number;
  paypalName?: string;
  reason?: string;
  debugId?: string;
  details?: unknown;

  constructor(
    status: number,
    body: {
      name?: string;
      message?: string;
      debug_id?: string;
      details?: unknown;
      // The token endpoint answers OAuth's shape instead (e.g. invalid_client).
      error?: string;
      error_description?: string;
    }
  ) {
    const name = body.name || body.error;
    const reason = body.message || body.error_description;
    const detail: any = Array.isArray(body.details) ? body.details[0] : null;
    const issue = typeof detail?.issue === 'string' ? detail.issue : '';
    super(
      `PayPal answered ${status}${name ? ` ${name}` : ''}${
        reason ? `: ${reason}` : ''
      }${issue ? ` (${issue})` : ''}`
    );
    this.name = 'PaypalApiError';
    this.status = status;
    this.paypalName = name;
    this.reason = reason;
    this.debugId = body.debug_id;
    this.details = body.details;
  }
}

// PayPal could not be reached (network error, timeout, connection cut mid-answer).
export class PaypalUnreachableError extends Error {
  constructor(cause: unknown) {
    super(
      `PayPal is unreachable: ${cause instanceof Error ? cause.message : cause}`
    );
    this.name = 'PaypalUnreachableError';
  }
}

// The PayPal env vars, read at call time. PAYPAL_MODE (sandbox or live, any case; live when unset)
// picks the API base and PAYPAL_API_BASE overrides it; an unknown mode leaves the base empty.
const readConfig = () => {
  const mode = (process.env.PAYPAL_MODE || '').trim().toLowerCase() || 'live';
  const override = (process.env.PAYPAL_API_BASE || '').trim();
  return {
    mode,
    base: (MODE_BASES[mode] ? override || MODE_BASES[mode] : '').replace(
      /\/+$/,
      ''
    ),
    clientId: (process.env.PAYPAL_CLIENT_ID || '').trim(),
    clientSecret: (process.env.PAYPAL_CLIENT_SECRET || '').trim(),
    webhookId: (process.env.PAYPAL_WEBHOOK_ID || '').trim(),
  };
};
type PaypalConfig = ReturnType<typeof readConfig>;

// Why PayPal is not configured (names only, never values), or '' when it is.
const configProblem = (config: PaypalConfig) => {
  if (!MODE_BASES[config.mode]) {
    return `PAYPAL_MODE "${config.mode}" is neither sandbox nor live`;
  }
  const missing = CREDENTIAL_VARS.filter(([key]) => !config[key]).map(
    ([, name]) => name
  );
  return missing.length ? `missing ${missing.join(', ')}` : '';
};

// The last problem logged, so each one is logged once per process rather than on every check.
let reportedProblem = '';

// The first value of a header, looked up without regard to case; empty when absent.
const headerValue = (headers: Headers, name: string) => {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const value = key ? headers[key] : undefined;
  return (Array.isArray(value) ? value[0] : value) || '';
};

// PayPal's error body, when the answer was JSON.
const parseBody = (text: string) => {
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
};

@Injectable()
export class PaypalClient {
  private readonly _logger = new Logger(PaypalClient.name);
  private _token?: { value: string; expiresAt: number };
  private _tokenRequest?: Promise<string>;

  // Whether PayPal is configured: a known PAYPAL_MODE and the client id, secret and webhook id set.
  // The reason it is not is logged once, unless no PayPal var is set at all (billing left off).
  isConfigured() {
    const problem = configProblem(readConfig());
    const anySet = Object.keys(process.env).some(
      (name) => name.startsWith('PAYPAL_') && !!process.env[name]?.trim()
    );
    if (problem && anySet && problem !== reportedProblem) {
      this._logger.warn(`PayPal is not configured: ${problem}`);
    }
    reportedProblem = problem;
    return !problem;
  }

  // The host of the PayPal API calls go to (e.g. api-m.sandbox.paypal.com): names the PayPal
  // environment, whose ids (plans, products) mean nothing in another one.
  apiHost() {
    return new URL(this.requireConfig().base).host;
  }

  // An authenticated call to PayPal with a JSON body. A `requestId` makes PayPal answer a
  // repeated POST with the first result, and is what allows retrying a POST or PATCH.
  async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    options?: { requestId?: string }
  ): Promise<T> {
    const config = this.requireConfig();
    if (!path.startsWith('/')) {
      throw new Error('A PayPal path must start with "/"');
    }
    const requestId = options?.requestId;
    const payload =
      method === 'GET' || body === undefined ? undefined : JSON.stringify(body);
    const retries = method === 'GET' || requestId ? MAX_RETRIES : 0;
    const text = await this.withRetries(method + ' ' + path, retries, () =>
      this.callOnce(config, method, path, payload, requestId)
    );
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // Asks PayPal whether a webhook's signature is genuine, sending the raw body exactly as
  // received. False for a missing header, a body that is not JSON or a bad signature; throws
  // only when PayPal cannot be reached or refuses our credentials.
  async verifyWebhookSignature(rawBody: Buffer, headers: Headers) {
    const config = this.requireConfig();
    const transmission = TRANSMISSION_HEADERS.map(
      ([field, header]) => [field, headerValue(headers, header)] as const
    );
    const rawText = rawBody.toString('utf8');
    if (transmission.some(([, value]) => !value) || !this.isJson(rawText)) {
      return false;
    }

    // The raw body is embedded as text: parsing and re-serialising it could change the bytes
    // PayPal signed.
    const payload = `{${transmission
      .map(
        ([field, value]) => `${JSON.stringify(field)}:${JSON.stringify(value)}`
      )
      .join(',')},"webhook_id":${JSON.stringify(
      config.webhookId
    )},"webhook_event":${rawText}}`;
    try {
      const text = await this.callOnce(config, 'POST', VERIFY_PATH, payload);
      return parseBody(text).verification_status === 'SUCCESS';
    } catch (err) {
      if (err instanceof PaypalApiError && [400, 422].includes(err.status)) {
        return false;
      }
      throw err;
    }
  }

  // The env config, or a PaypalNotConfiguredError while PayPal is not configured.
  private requireConfig() {
    if (!this.isConfigured()) {
      throw new PaypalNotConfiguredError();
    }
    return readConfig();
  }

  // Whether the text is one valid JSON document.
  private isJson(text: string) {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }

  // Runs one call, repeating it up to `retries` times when PayPal is unreachable or answers 5xx.
  private async withRetries(
    label: string,
    retries: number,
    call: () => Promise<string>
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (err) {
        const transient =
          err instanceof PaypalUnreachableError ||
          (err instanceof PaypalApiError && err.status >= 500);
        if (!transient || attempt >= retries) {
          throw err;
        }
        this._logger.warn(
          `${label} failed (${
            err instanceof PaypalApiError ? err.status : 'unreachable'
          }), retry ${attempt + 1}`
        );
        await timer(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  // One authenticated HTTP call to PayPal; the answer's text, or a PaypalApiError.
  private async callOnce(
    config: PaypalConfig,
    method: string,
    path: string,
    payload?: string,
    requestId?: string
  ) {
    const token = await this.accessToken(config);
    return this.fetchText(
      config.base + path,
      method,
      {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
      },
      payload
    );
  }

  // The cached access token, fetched first when missing or nearly expired; concurrent callers
  // share one fetch.
  private accessToken(config: PaypalConfig) {
    if (this._token && this._token.expiresAt > Date.now()) {
      return Promise.resolve(this._token.value);
    }
    this._tokenRequest ??= this.withRetries('token', MAX_RETRIES, () =>
      this.fetchToken(config)
    ).finally(() => {
      this._tokenRequest = undefined;
    });
    return this._tokenRequest;
  }

  // Exchanges the client credentials for an access token and caches it until shortly before it
  // expires.
  private async fetchToken(config: PaypalConfig) {
    const text = await this.fetchText(
      `${config.base}/v1/oauth2/token`,
      'POST',
      {
        Authorization: `Basic ${Buffer.from(
          `${config.clientId}:${config.clientSecret}`
        ).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      'grant_type=client_credentials'
    );
    const body = parseBody(text);
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new PaypalApiError(200, { name: 'INVALID_TOKEN_RESPONSE' });
    }
    this._token = {
      value: body.access_token,
      expiresAt:
        Date.now() + Number(body.expires_in || 0) * 1000 - TOKEN_SKEW_MS,
    };
    return body.access_token as string;
  }

  // One HTTP call; the answer's text for a 2xx, a PaypalApiError otherwise, a
  // PaypalUnreachableError when no complete answer arrived.
  private async fetchText(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string
  ) {
    let status: number;
    let text: string;
    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      text = await res.text();
    } catch (cause) {
      throw new PaypalUnreachableError(cause);
    }
    if (status < 200 || status >= 300) {
      const error = new PaypalApiError(status, parseBody(text));
      // PayPal's reason and debug id, the path without its host; never headers or bodies we sent.
      this._logger.warn(
        `${method} ${new URL(url).pathname}: ${error.message}${
          error.debugId ? ` [debug_id ${error.debugId}]` : ''
        }`
      );
      throw error;
    }
    return text;
  }
}
