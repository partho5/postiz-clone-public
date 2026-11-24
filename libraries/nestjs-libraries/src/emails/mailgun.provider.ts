// Mail sender: sends one email through Mailgun's HTTP API.
import { EmailInterface } from '@gitroom/nestjs-libraries/emails/email.interface';

const HOSTS: Record<string, string> = {
  us: 'https://api.mailgun.net',
  eu: 'https://api.eu.mailgun.net',
};

// The host messages go to: MAILGUN_API_BASE when set, otherwise the one MAILGUN_REGION names.
const apiBase = () => {
  if (process.env.MAILGUN_API_BASE) {
    return process.env.MAILGUN_API_BASE.replace(/\/+$/, '');
  }
  const region = (process.env.MAILGUN_REGION || 'us').toLowerCase();
  const host = HOSTS[region];
  if (!host) {
    throw new Error(`MAILGUN_REGION must be "us" or "eu", got "${region}"`);
  }
  return host;
};

// How long one send may take, in milliseconds.
export const timeoutMs = () => {
  const seconds = Number(process.env.MAIL_SEND_TIMEOUT_SECONDS);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 10) * 1000;
};

// Email provider that delivers through Mailgun's HTTP API.
export class MailgunProvider implements EmailInterface {
  name = 'mailgun';
  validateEnvKeys = ['MAILGUN_API_KEY', 'MAILGUN_DOMAIN'];

  // Posts the message to Mailgun's messages endpoint; rejects with the status on any non-2xx answer.
  async sendEmail(
    to: string,
    subject: string,
    html: string,
    emailFromName: string,
    emailFromAddress: string,
    replyTo?: string
  ) {
    const form = new URLSearchParams({
      from: `${emailFromName} <${emailFromAddress}>`,
      to,
      subject,
      html,
    });
    if (replyTo) {
      form.set('h:Reply-To', replyTo);
    }

    const response = await fetch(
      `${apiBase()}/v3/${encodeURIComponent(
        process.env.MAILGUN_DOMAIN!.trim()
      )}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(
            `api:${process.env.MAILGUN_API_KEY!.trim()}`
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: AbortSignal.timeout(timeoutMs()),
      }
    );

    if (!response.ok) {
      throw new Error(`Mailgun answered ${response.status}`);
    }
    return { sent: true };
  }
}
