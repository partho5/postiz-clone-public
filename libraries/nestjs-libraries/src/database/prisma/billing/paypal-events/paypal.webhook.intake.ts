// PayPal webhook intake: a PayPal notice is acted on only when genuine, and each event
// id at most once; the sub-modules that own a kind of event register their handler here.
import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { PaypalClient } from '@gitroom/nestjs-libraries/services/paypal/paypal.client';
import { PaypalEventsRepository } from '@gitroom/nestjs-libraries/database/prisma/billing/paypal-events/paypal.events.repository';

// PayPal's list of webhook events, read by the replay.
const EVENTS_PATH = '/v1/notifications/webhooks-events';
const EVENTS_PAGE_SIZE = 100;

export interface PaypalEvent {
  id: string;
  event_type: string;
  resource_type: string;
  resource: any;
  create_time: string;
}

export type PaypalEventHandler = (event: PaypalEvent) => Promise<void>;

type Headers = Record<string, string | string[] | undefined>;
export type IntakeOutcome = 'processed' | 'duplicate' | 'ignored';

// Thrown by `verify` when a notice is not signed by PayPal or is not an event.
export class InvalidWebhookSignatureError extends Error {
  constructor() {
    super('The PayPal webhook signature is not valid');
    this.name = 'InvalidWebhookSignatureError';
  }
}

// The value as a PaypalEvent, or null when it has no event id or type.
const asEvent = (value: any): PaypalEvent | null => {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.event_type !== 'string' ||
    !value.event_type
  ) {
    return null;
  }
  return value as PaypalEvent;
};

// The `next` page link of a PayPal list answer, as a path on the events endpoint, or null.
const nextEventsPath = (answer: any) => {
  const link = (answer?.links || []).find((l: any) =>
    ['next', 'next_page'].includes(l?.rel)
  );
  if (!link?.href) {
    return null;
  }
  try {
    const url = new URL(link.href, 'https://paypal.invalid');
    return url.pathname === EVENTS_PATH ? url.pathname + url.search : null;
  } catch {
    return null;
  }
};

@Injectable()
export class PaypalWebhookIntake {
  private readonly _logger = new Logger(PaypalWebhookIntake.name);
  private readonly _handlers: {
    pattern: string;
    handler: PaypalEventHandler;
  }[] = [];

  constructor(
    private readonly _client: PaypalClient,
    private readonly _repository: PaypalEventsRepository
  ) {}

  // Registers a handler for the given event types; a type ending in ".*" matches every type
  // that starts with what precedes the "*".
  on(eventTypes: string[], handler: PaypalEventHandler) {
    for (const pattern of eventTypes) {
      this._handlers.push({ pattern, handler });
    }
  }

  // The event in a webhook request PayPal signed; InvalidWebhookSignatureError otherwise.
  async verify(rawBody: Buffer, headers: Headers): Promise<PaypalEvent> {
    if (!(await this._client.verifyWebhookSignature(rawBody, headers))) {
      throw new InvalidWebhookSignatureError();
    }
    let event: PaypalEvent | null = null;
    try {
      event = asEvent(JSON.parse(rawBody.toString('utf8')));
    } catch {
      event = null;
    }
    if (!event) {
      throw new InvalidWebhookSignatureError();
    }
    return event;
  }

  // Runs the handlers registered for the event once per event id: `duplicate` when the id is
  // already processed, `ignored` when no handler is registered for its type. A handler that
  // throws leaves the event unprocessed and the error propagates, so PayPal redelivers.
  async process(event: PaypalEvent): Promise<IntakeOutcome> {
    if (!asEvent(event)) {
      throw new Error('A PayPal event needs an id and an event type');
    }
    const handlers = this.handlersFor(event.event_type);
    await this._repository.record({
      id: event.id,
      eventType: event.event_type,
      resourceId:
        typeof event.resource?.id === 'string' ? event.resource.id : null,
      payload: event,
    });
    try {
      const ran = await this._repository.runOnce(event.id, async () => {
        for (const handler of handlers) {
          await handler(event);
        }
      });
      if (!ran) {
        return 'duplicate';
      }
    } catch (err) {
      this._logger.error(
        `paypal: event ${event.id} (${event.event_type}) failed, it stays unprocessed`
      );
      Sentry.captureException(err, {
        extra: { eventId: event.id, eventType: event.event_type },
      });
      throw err;
    }
    return handlers.length ? 'processed' : 'ignored';
  }

  // Verifies a webhook request, then processes its event.
  async receive(rawBody: Buffer, headers: Headers) {
    return this.process(await this.verify(rawBody, headers));
  }

  // Processes, oldest first, the events PayPal lists since `since` that are not yet processed.
  // An event whose handler fails is logged and stays unprocessed for the next replay.
  async replay(since: Date) {
    const listed = await this.listEvents(since);
    const done = await this._repository.processedIds(listed.map((e) => e.id));
    let processed = 0;
    let failed = 0;
    for (const event of listed.filter((e) => !done.has(e.id))) {
      try {
        if ((await this.process(event)) !== 'duplicate') {
          processed++;
        }
      } catch {
        failed++;
      }
    }
    if (failed) {
      this._logger.error(
        `paypal: replay left ${failed} event(s) unprocessed, the next replay retries them`
      );
    }
    return { seen: listed.length, processed };
  }

  // The processed event of this type whose resource id is `resourceId`, or null.
  async findProcessedEvent(eventType: string, resourceId: string) {
    return asEvent(await this._repository.findProcessed(eventType, resourceId));
  }

  // The handlers registered for an event type, in registration order.
  private handlersFor(eventType: string) {
    return this._handlers
      .filter(({ pattern }) =>
        pattern.endsWith('*')
          ? eventType.startsWith(pattern.slice(0, -1))
          : pattern === eventType
      )
      .map(({ handler }) => handler);
  }

  // Every event PayPal lists since `since`, unique by id and oldest first.
  private async listEvents(since: Date) {
    const events = new Map<string, PaypalEvent>();
    const visited = new Set<string>();
    let path:
      | string
      | null = `${EVENTS_PATH}?page_size=${EVENTS_PAGE_SIZE}&start_time=${encodeURIComponent(
      since.toISOString()
    )}`;
    while (path && !visited.has(path)) {
      visited.add(path);
      const answer: any = await this._client.request('GET', path);
      for (const value of answer?.events || []) {
        const event = asEvent(value);
        if (event) {
          events.set(event.id, event);
        }
      }
      path = nextEventsPath(answer);
    }
    return [...events.values()].sort(
      (a, b) => Date.parse(a.create_time) - Date.parse(b.create_time)
    );
  }
}
