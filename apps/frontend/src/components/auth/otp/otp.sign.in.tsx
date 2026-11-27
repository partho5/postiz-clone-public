'use client';

// Email one-time-code sign-in: the email-then-code form on the /auth and /auth/login pages.
import { FC, FormEvent, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { FetchWrapperComponent, useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { GithubProvider } from '@gitroom/frontend/components/auth/providers/github.provider';
import { OauthProvider } from '@gitroom/frontend/components/auth/providers/oauth.provider';
import { GoogleProvider } from '@gitroom/frontend/components/auth/providers/google.provider';
import { AppleProvider } from '@gitroom/frontend/components/auth/providers/apple.provider';
import { FarcasterProvider } from '@gitroom/frontend/components/auth/providers/farcaster.provider';
import { setCookie } from '@gitroom/frontend/components/layout/layout.context';
import {
  useOtpSignIn,
  waitOf,
} from '@gitroom/frontend/components/auth/otp/use.otp.sign.in';

// Builds the answer handler of the form's own fetch. The app-wide handler (layout.context.tsx) sends every 401 to `/`, and a refused
// code is a 401, so this one never redirects: a refused code leaves the person on the code step,
// and without TLS it keeps the access token the sign-in answer carries in its `auth` header as a cookie, as the app's handler does.
export const keepPage =
  (isSecured: boolean) =>
  async (_url: string, _options: RequestInit, response: Response) => {
    const token = response.headers?.get('auth');
    if (token && !isSecured) {
      setCookie('auth', token, 365);
    }
    return true;
  };

// What a provider sign-in that came back to this page left: a line to show, or the seconds a 429 asked to wait.
type ProviderReturn = { notice: string; wait: number };

// Signs in a provider sign-in that came back to this page: its linked account, or the account of the
// address the provider verified; says so when the provider vouches for no address and has no account here.
const useProviderReturn = (): ProviderReturn => {
  const fetchData = useFetch();
  const query = useSearchParams();
  const t = useT();
  const [notice, setNotice] = useState('');
  const [wait, setWait] = useState(0);
  const started = useRef(false);

  // Signs the person in when the server finds or creates the account; the app reloads, or opens the
  // quick start of a new account, on the answer.
  useEffect(() => {
    const provider = query?.get('provider')?.toUpperCase();
    const code = query?.get('code');
    if (!provider || !code || started.current) {
      return;
    }
    started.current = true;
    fetchData(`/auth/oauth/${provider}/exists`, {
      method: 'POST',
      body: JSON.stringify({ code, state: query?.get('state') || '' }),
    })
      .then((response) => {
        if (response.status === 429) {
          setWait(waitOf(response));
          return {} as { token?: string };
        }
        if (!response.ok) {
          throw new Error('provider sign-in failed');
        }
        return response.json() as Promise<{ token?: string }>;
      })
      .then(({ token }) => {
        if (token) {
          setNotice(
            t(
              'otp_provider_no_account',
              'There is no account for that sign-in yet. Enter your email to get a code.'
            )
          );
        }
      })
      .catch(() => {
        setNotice(
          t('otp_provider_failed', "That sign-in didn't work. Try again.")
        );
      });
  }, [fetchData, query, t]);

  return { notice, wait };
};

// The provider sign-in buttons, as the sign-in page showed them before the password form went.
const ProviderButtons: FC = () => {
  const { isGeneral, neynarClientId, appleClientId, genericOauth } =
    useVariables();
  if (isGeneral && genericOauth) {
    return <OauthProvider />;
  }
  if (!isGeneral) {
    return <GithubProvider />;
  }
  return (
    <div className="gap-[8px] flex">
      <GoogleProvider />
      {!!appleClientId && <AppleProvider />}
      {!!neynarClientId && <FarcasterProvider />}
    </div>
  );
};

// The email step and the code step of the form, with the message the last request left.
const OtpForm: FC<{ providerReturn: ProviderReturn }> = ({
  providerReturn,
}) => {
  const t = useT();
  const otp = useOtpSignIn();
  const waiting = otp.wait > 0;
  const { limitedFor } = otp;
  const providerNotice = providerReturn.notice;

  // Starts the wait when a provider sign-in was refused for too many failed sign-in attempts.
  useEffect(() => {
    if (providerReturn.wait > 0) {
      limitedFor(providerReturn.wait);
    }
  }, [providerReturn.wait, limitedFor]);

  // Sends the code on the email step and signs in on the code step.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (otp.step === 'email') {
      otp.sendCode(false);
    } else {
      otp.signIn(otp.code);
    }
  };

  return (
    <form className="flex flex-col gap-[12px]" onSubmit={submit} noValidate>
      {otp.step === 'email' ? (
        <Input
          disableForm
          label="Email"
          translationKey="label_email"
          name="email"
          aria-label={t('label_email', 'Email')}
          type="email"
          autoComplete="email"
          placeholder={t('email_address', 'Email Address')}
          value={otp.email}
          onChange={(event) => otp.setEmail(event.target.value)}
          error={otp.error}
        />
      ) : (
        <>
          <div className="text-[14px]">
            {t('otp_code_sent_to', 'We sent a six-digit code to')}{' '}
            <span className="font-[600]">{otp.email}</span>
          </div>
          <Input
            disableForm
            label="Code"
            translationKey="otp_label_code"
            name="code"
            aria-label={t('otp_label_code', 'Code')}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            placeholder="123456"
            value={otp.code}
            onChange={(event) => otp.changeCode(event.target.value)}
            error={otp.error}
          />
        </>
      )}
      {!!providerNotice && otp.step === 'email' && !otp.error && (
        <div className="text-[12px] text-amber-400">{providerNotice}</div>
      )}
      {!!otp.notice && (
        <div className="text-[12px] text-textColor">{otp.notice}</div>
      )}
      <div className="w-full flex mt-[12px]">
        <Button
          type="submit"
          data-testid="otp-submit"
          className="flex-1 rounded-[10px] !h-[52px]"
          loading={otp.loading}
          disabled={waiting}
        >
          {otp.step === 'email'
            ? t('otp_send_code', 'Send code')
            : t('sign_in_1', 'Sign in')}
        </Button>
      </div>
      {otp.step === 'code' && (
        <div className="flex flex-col items-center gap-[8px] text-sm">
          <button
            type="button"
            className="underline hover:font-bold cursor-pointer disabled:opacity-50 disabled:no-underline"
            disabled={waiting || otp.loading}
            onClick={() => otp.sendCode(true)}
          >
            {t('otp_send_new_code', 'Send a new code')}
          </button>
          <button
            type="button"
            className="underline hover:font-bold cursor-pointer"
            onClick={otp.changeEmail}
          >
            {t('otp_use_different_email', 'Use a different email')}
          </button>
        </div>
      )}
    </form>
  );
};

// The sign-in screen: provider buttons, then the email-then-code form.
export const OtpSignIn: FC = () => {
  const t = useT();
  const { backendUrl, isSecured } = useVariables();
  const providerReturn = useProviderReturn();
  return (
    <div className="flex flex-col flex-1">
      <div>
        <h1 className="text-[40px] font-[500] -tracking-[0.8px] text-start cursor-pointer">
          {t('sign_in', 'Sign In')}
        </h1>
      </div>
      <div className="text-[14px] mt-[32px] mb-[12px]">
        {t('continue_with', 'Continue With')}
      </div>
      <div className="flex flex-col">
        <ProviderButtons />
        <div className="h-[20px] mb-[24px] mt-[24px] relative">
          <div className="absolute w-full h-[1px] bg-fifth top-[50%] -translate-y-[50%]" />
          <div
            className={`absolute z-[1] justify-center items-center w-full start-0 -top-[4px] flex`}
          >
            <div className="px-[16px]">{t('or', 'or')}</div>
          </div>
        </div>
        <div className="text-textColor">
          <FetchWrapperComponent baseUrl={backendUrl} afterRequest={keepPage(isSecured)}>
            <OtpForm providerReturn={providerReturn} />
          </FetchWrapperComponent>
        </div>
      </div>
    </div>
  );
};
