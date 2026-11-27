// Mail sender: local-run provider that writes the message to the log instead of sending it.
import { EmailInterface } from '@gitroom/nestjs-libraries/emails/email.interface';

// Email provider for local runs that writes each message to the log.
export class LogProvider implements EmailInterface {
  name = 'log';
  validateEnvKeys = [];

  // Writes recipient, subject and body to the log; never refused here (EmailService refuses it in production).
  async sendEmail(to: string, subject: string, html: string) {
    console.log(`[mail:log] to=${to} subject=${subject}\n${html}`);
    return { sent: true };
  }
}
