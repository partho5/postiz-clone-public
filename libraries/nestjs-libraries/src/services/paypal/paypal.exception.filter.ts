// PayPal billing routes: a call to PayPal that failed answers 502 with PayPal's reason, not a bare 500.
import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';
import * as Sentry from '@sentry/nestjs';
import {
  PaypalApiError,
  PaypalUnreachableError,
} from '@gitroom/nestjs-libraries/services/paypal/paypal.client';

// Answers 502 PAYMENT_PROVIDER_ERROR with PayPal's message and debug id (the client already logged
// them); reported to Sentry, since the global filter never sees an error caught here.
@Catch(PaypalApiError, PaypalUnreachableError)
export class PaypalErrorFilter implements ExceptionFilter {
  catch(
    exception: PaypalApiError | PaypalUnreachableError,
    host: ArgumentsHost
  ) {
    Sentry.captureException(exception);
    const response = host.switchToHttp().getResponse<Response>();
    if (!(exception instanceof PaypalApiError)) {
      return response.status(502).json({
        statusCode: 502,
        code: 'PAYMENT_PROVIDER_ERROR',
        message: 'PayPal could not be reached. Try again in a moment.',
        debugId: null,
      });
    }
    const reason = exception.reason || exception.paypalName;
    return response.status(502).json({
      statusCode: 502,
      code: 'PAYMENT_PROVIDER_ERROR',
      message: `PayPal refused the request${reason ? `: ${reason}` : ''}.`,
      debugId: exception.debugId ?? null,
    });
  }
}
