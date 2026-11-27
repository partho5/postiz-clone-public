export const dynamic = 'force-dynamic';
import { OtpSignIn } from '@gitroom/frontend/components/auth/otp/otp.sign.in';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Login`,
  description: '',
};
// The sign-in page at /auth/login: the email-then-code form.
export default async function Auth() {
  return <OtpSignIn />;
}
