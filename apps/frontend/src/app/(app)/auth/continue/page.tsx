export const dynamic = 'force-dynamic';
import { WebHandoff } from '@gitroom/frontend/components/auth/web.handoff';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Sign In`,
  description: '',
};
// The page at /auth/continue the app's one-time links open: signs the person in and opens the link's page.
export default async function Continue() {
  return <WebHandoff />;
}
