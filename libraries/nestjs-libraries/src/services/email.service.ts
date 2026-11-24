import { Injectable } from '@nestjs/common';
import { EmailInterface } from '@gitroom/nestjs-libraries/emails/email.interface';
import { ResendProvider } from '@gitroom/nestjs-libraries/emails/resend.provider';
import { EmptyProvider } from '@gitroom/nestjs-libraries/emails/empty.provider';
import { NodeMailerProvider } from '@gitroom/nestjs-libraries/emails/node.mailer.provider';
import {
  MailgunProvider,
  timeoutMs as mailSendTimeoutMs,
} from '@gitroom/nestjs-libraries/emails/mailgun.provider';
import { LogProvider } from '@gitroom/nestjs-libraries/emails/log.provider';
import { TemporalService } from 'nestjs-temporal-core';
import { timer } from '@gitroom/helpers/utils/timer';

// Why a message could not be sent: no usable provider setup, or the provider failed.
export class MailDeliveryError extends Error {
  // Records which failure it is (`code`) and the provider error behind it (`cause`).
  constructor(
    public code: 'MAIL_NOT_CONFIGURED' | 'MAIL_DELIVERY_FAILED',
    public cause?: unknown
  ) {
    super(code);
    this.name = 'MailDeliveryError';
  }
}

@Injectable()
export class EmailService {
  emailService: EmailInterface;
  // Picks the provider named by EMAIL_PROVIDER; in production it refuses to start without a real provider and its settings.
  constructor(private _temporalService: TemporalService) {
    this.emailService = this.selectProvider(process.env.EMAIL_PROVIDER!);
    if (process.env.NODE_ENV === 'production') {
      this.assertProductionMail();
    }
    console.log('Email service provider:', this.emailService.name);
    for (const key of this.emailService.validateEnvKeys) {
      if (!process.env[key]) {
        console.error(`Missing environment variable: ${key}`);
      }
    }
  }

  // Throws unless the provider is a real one and every setting it and the sender need is set.
  private assertProductionMail() {
    if (this.emailService instanceof LogProvider) {
      throw new Error('EMAIL_PROVIDER=log is refused in production');
    }
    if (!this.hasProvider()) {
      throw new Error(
        'EMAIL_PROVIDER must be mailgun, resend or nodemailer in production'
      );
    }
    const missing = [
      ...this.emailService.validateEnvKeys,
      'EMAIL_FROM_NAME',
      'EMAIL_FROM_ADDRESS',
    ].filter((key) => !process.env[key]);
    if (missing.length) {
      throw new Error(
        `Missing mail settings in production: ${missing.join(', ')}`
      );
    }
  }

  hasProvider() {
    return !(this.emailService instanceof EmptyProvider);
  }

  // Builds the email provider for an EMAIL_PROVIDER value; an unknown or empty value gets the empty provider.
  selectProvider(provider: string) {
    switch (provider) {
      case 'resend':
        return new ResendProvider();
      case 'nodemailer':
        return new NodeMailerProvider();
      case 'mailgun':
        return new MailgunProvider();
      case 'log':
        return new LogProvider();
      default:
        return new EmptyProvider();
    }
  }

  async sendEmail(
    to: string,
    subject: string,
    html: string,
    addTo: 'top' | 'bottom',
    replyTo?: string
  ) {
    return this._temporalService.client
      .getRawClient()
      ?.workflow.signalWithStart('sendEmailWorkflow', {
        taskQueue: 'main',
        workflowId: 'send_email',
        signal: 'sendEmail',
        args: [{ queue: [] }],
        signalArgs: [{ to, subject, html, replyTo, addTo }],
        workflowIdConflictPolicy: 'USE_EXISTING',
      });
  }

  // Puts a message body inside the standard email layout.
  private wrapHtml(subject: string, html: string) {
    return `
    <div style="
        background: linear-gradient(to bottom right, #e6f2ff, #f0e6ff);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2rem;
    ">
        <div style="
            background-color: rgba(255, 255, 255, 0.9);
            backdrop-filter: blur(4px);
            border-radius: 0.5rem;
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
            max-width: 48rem;
            width: 100%;
            padding: 2rem;
        ">
            <h1 style="
                font-size: 1.875rem;
                font-weight: bold;
                margin-bottom: 1.5rem;
                text-align: left;
                color: #1f2937;
            ">${subject}</h1>
            
            <div style="
                margin-bottom: 2rem;
                color: #374151;
            ">
                ${html}
            </div>
            
            <div style="
                display: flex;
                align-items: center;
                border-top: 1px solid #e5e7eb;
                padding-top: 1.5rem;
            ">
                <div>
                    <h2 style="
                        font-size: 1.25rem;
                        font-weight: 600;
                        color: #1f2937;
                        margin: 0;
                    ">${process.env.EMAIL_FROM_NAME}</h2>
                    <div style="font-size: 12px">
                      You can change your notification preferences in your <a href="${process.env.FRONTEND_URL}/settings">account settings.</a>
                     </div>
                </div>
            </div>
        </div>
    </div>
    `;
  }

  // Sends one email now with up to three attempts; returns quietly when it cannot be sent.
  async sendEmailSync(
    to: string,
    subject: string,
    html: string,
    replyTo?: string
  ) {
    if (to.indexOf('@') === -1) {
      return;
    }

    if (!process.env.EMAIL_FROM_ADDRESS || !process.env.EMAIL_FROM_NAME) {
      console.log(
        'Email sender information not found in environment variables'
      );
      return;
    }

    const modifiedHtml = this.wrapHtml(subject, html);

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sends = await this.emailService.sendEmail(
          to,
          subject,
          modifiedHtml,
          process.env.EMAIL_FROM_NAME,
          process.env.EMAIL_FROM_ADDRESS,
          replyTo
        );
        console.log(sends);
        return;
      } catch (err) {
        lastErr = err;
        console.log(`Email attempt ${attempt + 1}/3 failed:`, err);
        if (attempt < 2) {
          await timer(700);
        }
      }
    }
    console.log(`Email to ${to} failed after 3 attempts:`, lastErr);
  }

  // Sends one email now through the selected provider and resolves only after it accepted the message.
  async sendRequired(to: string, subject: string, html: string) {
    const fromName = process.env.EMAIL_FROM_NAME;
    const fromAddress = process.env.EMAIL_FROM_ADDRESS;
    if (
      !this.hasProvider() ||
      !fromName ||
      !fromAddress ||
      this.emailService.validateEnvKeys.some((key) => !process.env[key])
    ) {
      throw new MailDeliveryError('MAIL_NOT_CONFIGURED');
    }

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.emailService.sendEmail(
          to,
          subject,
          this.wrapHtml(subject, html),
          fromName,
          fromAddress
        ),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('mail send timed out')),
            mailSendTimeoutMs()
          );
        }),
      ]);
    } catch (err) {
      console.log(`Email via ${this.emailService.name} failed`);
      throw new MailDeliveryError('MAIL_DELIVERY_FAILED', err);
    } finally {
      clearTimeout(timeout);
    }
  }
}
