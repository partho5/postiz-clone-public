import { internalFetch } from '@gitroom/helpers/utils/internal.fetch';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
export const dynamic = 'force-dynamic';
import { OtpSignIn } from '@gitroom/frontend/components/auth/otp/otp.sign.in';
import { Metadata } from 'next';
import { WorkspaceLink } from '@gitroom/frontend/components/layout/workspace.navigation';
import { getT } from '@gitroom/react/translation/get.translation.service.backend';
import { LoginWithOidc } from '@gitroom/frontend/components/auth/login.with.oidc';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Sign In`,
  description: '',
};
// The sign-in page at /auth: the email-then-code form, or the registration-disabled notice when sign-up is closed.
export default async function Auth(params: {searchParams: Promise<{provider: string}>}) {
  const t = await getT();
  if (process.env.DISABLE_REGISTRATION === 'true') {
    const canRegister = (
      await (await internalFetch('/auth/can-register')).json()
    ).register;
    if (!canRegister && !(await params?.searchParams)?.provider) {
      return (
        <>
          <LoginWithOidc />
          <div className="text-center">
            {t('registration_is_disabled', 'Registration is disabled')}
            <br />
            <WorkspaceLink className="underline hover:font-bold" href="/auth/login">
              {t('login_instead', 'Login instead')}
            </WorkspaceLink>
          </div>
        </>
      );
    }
  }
  return <OtpSignIn />;
}
