'use client';

// Email one-time-code sign-in: the two-step state and requests behind the sign-in form.
import { useCallback, useEffect, useRef, useState } from 'react';
import { isEmail } from 'class-validator';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { workspacePath } from '@gitroom/helpers/utils/workspace.path';
import { useReturnUrl } from '@gitroom/frontend/app/(app)/auth/return.url.component';

export type OtpStep = 'email' | 'code';

// The six digits of a code, however it was typed or pasted.
const CODE_LENGTH = 6;

// The digits of whatever was typed or pasted, cut to the length of a code.
export const digitsOf = (value: string) =>
  value.replace(/\D/g, '').slice(0, CODE_LENGTH);

// The seconds a 429 asks the person to wait, read from its Retry-After header.
export const waitOf = (response: Response) => {
  const seconds = Number(response.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
};

// The step, the typed email and code, the message to show and the actions of the sign-in form.
export const useOtpSignIn = () => {
  const fetchData = useFetch();
  const returnUrl = useReturnUrl();
  const t = useT();
  const [step, setStep] = useState<OtpStep>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  // the moment a 429's wait ends (0 when none), and the whole seconds left until it
  const [limitedUntil, setLimitedUntil] = useState(0);
  const [wait, setWait] = useState(0);
  const busy = useRef(false);

  // Counts a 429's wait down to zero from its end time, once a second, and stops at zero.
  useEffect(() => {
    if (!limitedUntil) {
      return;
    }
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((limitedUntil - Date.now()) / 1000));
      setWait(left);
      if (!left) {
        clearInterval(timer);
        setLimitedUntil(0);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [limitedUntil]);

  // Starts the wait a 429 asked for; the line saying how long is built from the seconds left.
  const limitedFor = useCallback((seconds: number) => {
    setError('');
    setWait(seconds);
    setLimitedUntil(Date.now() + seconds * 1000);
  }, []);

  // The line for the form: the seconds left of a 429's wait while it lasts, else the last request's line.
  const message =
    wait === 1
      ? t('otp_rate_limited_second', 'Too many attempts. Try again in 1 second.')
      : wait > 0
      ? t(
          'otp_rate_limited',
          'Too many attempts. Try again in {{seconds}} seconds.',
          { seconds: wait }
        )
      : error;

  // Shows the line for a refused or failed request and starts the wait of a 429.
  const fail = useCallback(
    (response: Response | undefined, refused: string) => {
      if (response?.status === 429) {
        limitedFor(waitOf(response));
        return;
      }
      setError(refused);
    },
    [limitedFor]
  );

  // Asks for a code for the typed email and moves to the code step; one call per click.
  const sendCode = useCallback(
    async (again: boolean) => {
      if (busy.current || wait > 0) {
        return;
      }
      setError('');
      setNotice('');
      if (!isEmail(email.trim())) {
        setError(t('otp_invalid_email', 'Enter a valid email address.'));
        return;
      }
      busy.current = true;
      setLoading(true);
      const sendFailed = t(
        'otp_send_failed',
        "We couldn't send the code. Try again."
      );
      try {
        const response = await fetchData('/auth/otp/request', {
          method: 'POST',
          body: JSON.stringify({ email: email.trim() }),
        });
        if (response.status === 204) {
          setCode('');
          setStep('code');
          if (again) {
            setNotice(t('otp_sent_again', 'We sent you a new code.'));
          }
        } else if (response.status === 400) {
          setError(t('otp_invalid_email', 'Enter a valid email address.'));
        } else {
          fail(response, sendFailed);
        }
      } catch {
        setError(sendFailed);
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [email, fail, fetchData, t, wait]
  );

  // Leaves for the page the sign-in was for: the saved return address, the quick start of a new account, or the home page.
  const leave = useCallback(
    (created: boolean) => {
      const target =
        returnUrl.getAndClear() ||
        (created ? workspacePath('/quick-start') : '/');
      // the page is replaced so back never returns to a used code form
      window.location.replace(target);
    },
    [returnUrl]
  );

  // Signs in with the code; a wrong code leaves the person on the code step with the email kept.
  const signIn = useCallback(
    async (typed: string) => {
      if (busy.current || wait > 0) {
        return;
      }
      setError('');
      setNotice('');
      if (typed.length !== CODE_LENGTH) {
        setError(t('otp_invalid_code_format', 'Enter the six-digit code.'));
        return;
      }
      busy.current = true;
      setLoading(true);
      try {
        const response = await fetchData('/auth/token', {
          method: 'POST',
          body: JSON.stringify({
            grant_type: 'email_otp',
            email: email.trim(),
            code: typed,
            device_name: 'Web browser',
          }),
        });
        if (response.ok) {
          leave(!!response.headers.get('onboarding'));
          return;
        }
        if (response.status === 400) {
          setError(t('otp_invalid_code_format', 'Enter the six-digit code.'));
        } else {
          fail(
            response,
            t(
              'otp_invalid_code',
              "That code didn't work. Check it or ask for a new one."
            )
          );
        }
        setLoading(false);
      } catch {
        setError(
          t('otp_sign_in_failed', "We couldn't sign you in. Try again.")
        );
        setLoading(false);
      } finally {
        busy.current = false;
      }
    },
    [email, fail, fetchData, leave, t, wait]
  );

  // Takes what was typed or pasted into the code field and signs in as soon as it is six digits.
  const changeCode = useCallback(
    (value: string) => {
      const digits = digitsOf(value);
      setCode(digits);
      if (digits.length === CODE_LENGTH) {
        signIn(digits);
      }
    },
    [signIn]
  );

  // Returns to the email step with the typed address kept for editing.
  const changeEmail = useCallback(() => {
    setStep('email');
    setCode('');
    setError('');
    setNotice('');
  }, []);

  return {
    step,
    email,
    setEmail,
    code,
    changeCode,
    error: message,
    notice,
    loading,
    wait,
    sendCode,
    signIn,
    changeEmail,
    limitedFor,
  };
};
