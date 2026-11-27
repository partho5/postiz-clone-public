// Mail sender: Mailgun and log providers and EmailService.sendRequired, against a local
// HTTP server that stands in for Mailgun.
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import {
  EmailService,
  MailDeliveryError,
} from '@gitroom/nestjs-libraries/services/email.service';
import { MailgunProvider } from '@gitroom/nestjs-libraries/emails/mailgun.provider';
import { LogProvider } from '@gitroom/nestjs-libraries/emails/log.provider';
import { ResendProvider } from '@gitroom/nestjs-libraries/emails/resend.provider';
import { NodeMailerProvider } from '@gitroom/nestjs-libraries/emails/node.mailer.provider';
import { EmptyProvider } from '@gitroom/nestjs-libraries/emails/empty.provider';

type Seen = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  form: URLSearchParams;
};

const KEY = 'key-super-secret-value';
const RECIPIENT = 'person@example.com';

let server: Server;
let baseUrl: string;
let seen: Seen[];
let answer: (res: ServerResponse) => void;
const savedEnv = { ...process.env };

// Stands in for the Temporal service; sendRequired must never touch it.
const temporal = new Proxy(
  {},
  {
    // Fails the test as soon as any property of the Temporal service is read.
    get() {
      throw new Error('sendRequired must not use Temporal');
    },
  }
) as any;

// Builds an EmailService the way the application does: the provider comes from EMAIL_PROVIDER.
const serviceFor = (provider: string) => {
  process.env.EMAIL_PROVIDER = provider;
  return new EmailService(temporal);
};

// Sets the environment a working Mailgun setup needs, pointing at the local server.
const mailgunEnv = () => {
  process.env.MAILGUN_API_KEY = KEY;
  process.env.MAILGUN_DOMAIN = 'mg.example.com';
  process.env.MAILGUN_API_BASE = baseUrl;
  process.env.EMAIL_FROM_NAME = 'Nany Social';
  process.env.EMAIL_FROM_ADDRESS = 'login@mg.example.com';
};

// Collects what the failed or successful call wrote to the log.
const logged = (spy: jest.SpyInstance) =>
  spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

beforeAll(async () => {
  // The stand-in Mailgun: records each request, then answers as the current test set `answer`.
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    // Runs once the whole request body has arrived.
    req.on('end', () => {
      seen.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        form: new URLSearchParams(Buffer.concat(chunks).toString('utf8')),
      });
      answer(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  seen = [];
  // Default answer: Mailgun accepting the message.
  answer = (res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: '<1@mg>', message: 'Queued. Thank you.' }));
  };
  process.env = { ...savedEnv };
  delete process.env.MAILGUN_REGION;
  delete process.env.MAIL_SEND_TIMEOUT_SECONDS;
  mailgunEnv();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...savedEnv };
});

describe('provider selection', () => {
  it('EMAIL_PROVIDER=mailgun selects the Mailgun provider and log selects the log provider', () => {
    expect(serviceFor('mailgun').emailService).toBeInstanceOf(MailgunProvider);
    expect(serviceFor('log').emailService).toBeInstanceOf(LogProvider);
  });

  it('the other providers are selected as before', () => {
    expect(serviceFor('resend').emailService).toBeInstanceOf(ResendProvider);
    expect(serviceFor('nodemailer').emailService).toBeInstanceOf(
      NodeMailerProvider
    );
    expect(serviceFor('').emailService).toBeInstanceOf(EmptyProvider);
    expect(serviceFor('').hasProvider()).toBe(false);
  });

  it('the log provider is refused in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => serviceFor('log')).toThrow();
    mailgunEnv();
    expect(() => serviceFor('mailgun')).not.toThrow();
  });

  it('production refuses to start without a real provider', () => {
    process.env.NODE_ENV = 'production';
    expect(() => serviceFor('')).toThrow('EMAIL_PROVIDER must be');
    expect(() => serviceFor('nonsense')).toThrow('EMAIL_PROVIDER must be');
  });

  it('production refuses to start when a provider or sender setting is missing, naming each', () => {
    process.env.NODE_ENV = 'production';
    mailgunEnv();
    delete process.env.MAILGUN_API_KEY;
    delete process.env.EMAIL_FROM_ADDRESS;
    expect(() => serviceFor('mailgun')).toThrow(
      'MAILGUN_API_KEY, EMAIL_FROM_ADDRESS'
    );
  });

  it('outside production an unset provider still starts, as before', () => {
    process.env.NODE_ENV = 'test';
    expect(() => serviceFor('')).not.toThrow();
  });
});

describe('MailgunProvider', () => {
  it('posts to the messages endpoint of the domain with basic auth and the message fields', async () => {
    await new MailgunProvider().sendEmail(
      RECIPIENT,
      'Your code',
      '<p>123456</p>',
      'Nany Social',
      'login@mg.example.com',
      'help@example.com'
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/v3/mg.example.com/messages');
    expect(seen[0].headers.authorization).toBe(
      `Basic ${Buffer.from(`api:${KEY}`).toString('base64')}`
    );
    expect(seen[0].form.get('from')).toBe('Nany Social <login@mg.example.com>');
    expect(seen[0].form.get('to')).toBe(RECIPIENT);
    expect(seen[0].form.get('subject')).toBe('Your code');
    expect(seen[0].form.get('html')).toBe('<p>123456</p>');
    expect(seen[0].form.get('h:Reply-To')).toBe('help@example.com');
  });

  it('declares the settings it needs', () => {
    expect(new MailgunProvider().validateEnvKeys).toEqual([
      'MAILGUN_API_KEY',
      'MAILGUN_DOMAIN',
    ]);
  });

  it('the region picks the host: us by default, eu on request', async () => {
    delete process.env.MAILGUN_API_BASE;
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await new MailgunProvider().sendEmail(RECIPIENT, 's', 'h', 'N', 'a@b.c');
    process.env.MAILGUN_REGION = 'eu';
    await new MailgunProvider().sendEmail(RECIPIENT, 's', 'h', 'N', 'a@b.c');

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://api.mailgun.net/v3/mg.example.com/messages'
    );
    expect(String(fetchSpy.mock.calls[1][0])).toBe(
      'https://api.eu.mailgun.net/v3/mg.example.com/messages'
    );
  });

  it('MAILGUN_API_BASE replaces the host the region gives', async () => {
    process.env.MAILGUN_REGION = 'eu';
    await new MailgunProvider().sendEmail(RECIPIENT, 's', 'h', 'N', 'a@b.c');
    expect(seen).toHaveLength(1);
  });

  it('a non-2xx answer rejects with the status and the key is not in the error', async () => {
    // Mailgun rejecting the key.
    answer = (res) => {
      res.writeHead(401);
      res.end('Forbidden');
    };
    const err = await new MailgunProvider()
      .sendEmail(RECIPIENT, 's', 'h', 'N', 'a@b.c')
      .catch((e) => e);
    expect(String(err.message)).toContain('401');
    expect(String(err.message)).not.toContain(KEY);
  });
});

describe('EmailService.sendRequired', () => {
  it('resolves after Mailgun accepted the message, sent with the configured sender and the standard layout', async () => {
    await serviceFor('mailgun').sendRequired(
      RECIPIENT,
      'Your code',
      '<b>123456</b>'
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].form.get('from')).toBe('Nany Social <login@mg.example.com>');
    expect(seen[0].form.get('to')).toBe(RECIPIENT);
    expect(seen[0].form.get('subject')).toBe('Your code');
    const html = seen[0].form.get('html')!;
    expect(html).toContain('<b>123456</b>');
    expect(html).toContain('Your code');
    expect(html).toContain('Nany Social');
  });

  it('uses the same layout as sendEmailSync', async () => {
    const service = serviceFor('log');
    const sent: string[] = [];
    jest
      .spyOn(service.emailService, 'sendEmail')
      // Captures the HTML the provider is handed instead of sending.
      .mockImplementation(async (_to, _subject, html) => {
        sent.push(html);
        return {};
      });

    await service.sendRequired(RECIPIENT, 'Subject', '<i>body</i>');
    await service.sendEmailSync(RECIPIENT, 'Subject', '<i>body</i>');

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
  });

  it('rejects MAIL_NOT_CONFIGURED with no real provider', async () => {
    const err = await serviceFor('')
      .sendRequired(RECIPIENT, 's', 'h')
      .catch((e) => e);
    expect(err).toBeInstanceOf(MailDeliveryError);
    expect(err.code).toBe('MAIL_NOT_CONFIGURED');
    expect(seen).toHaveLength(0);
  });

  it.each([
    'MAILGUN_API_KEY',
    'MAILGUN_DOMAIN',
    'EMAIL_FROM_NAME',
    'EMAIL_FROM_ADDRESS',
  ])(
    'rejects MAIL_NOT_CONFIGURED without %s and sends nothing',
    async (name) => {
      const service = serviceFor('mailgun');
      delete process.env[name];
      const err = await service
        .sendRequired(RECIPIENT, 's', 'h')
        .catch((e) => e);
      expect(err).toBeInstanceOf(MailDeliveryError);
      expect(err.code).toBe('MAIL_NOT_CONFIGURED');
      expect(seen).toHaveLength(0);
    }
  );

  it('rejects MAIL_DELIVERY_FAILED when the provider answers non-2xx, and logs neither key, recipient nor body', async () => {
    // Mailgun failing.
    answer = (res) => {
      res.writeHead(500);
      res.end('boom');
    };
    const log = jest.spyOn(console, 'log');
    const err = await serviceFor('mailgun')
      .sendRequired(RECIPIENT, 'Your code', '<b>654321</b>')
      .catch((e) => e);

    expect(err).toBeInstanceOf(MailDeliveryError);
    expect(err.code).toBe('MAIL_DELIVERY_FAILED');
    expect(logged(log)).not.toContain(KEY);
    expect(logged(log)).not.toContain(RECIPIENT);
    expect(logged(log)).not.toContain('654321');
  });

  it('rejects MAIL_DELIVERY_FAILED when the connection fails', async () => {
    process.env.MAILGUN_API_BASE = 'http://127.0.0.1:1';
    const err = await serviceFor('mailgun')
      .sendRequired(RECIPIENT, 's', 'h')
      .catch((e) => e);
    expect(err.code).toBe('MAIL_DELIVERY_FAILED');
  });

  it('rejects MAIL_DELIVERY_FAILED when the provider does not answer within MAIL_SEND_TIMEOUT_SECONDS', async () => {
    // Mailgun never answering.
    answer = () => undefined;
    process.env.MAIL_SEND_TIMEOUT_SECONDS = '1';
    const started = Date.now();
    const err = await serviceFor('mailgun')
      .sendRequired(RECIPIENT, 's', 'h')
      .catch((e) => e);
    expect(err.code).toBe('MAIL_DELIVERY_FAILED');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('does not queue through Temporal (the stand-in throws if touched)', async () => {
    await expect(
      serviceFor('mailgun').sendRequired(RECIPIENT, 's', 'h')
    ).resolves.toBeUndefined();
  });
});

describe('LogProvider', () => {
  it('writes recipient, subject and body to the log and resolves', async () => {
    const log = jest.spyOn(console, 'log');
    await serviceFor('log').sendRequired(
      RECIPIENT,
      'Your code',
      '<b>112233</b>'
    );
    const out = logged(log);
    expect(out).toContain(RECIPIENT);
    expect(out).toContain('Your code');
    expect(out).toContain('112233');
  });
});
