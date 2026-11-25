// The way out for a browser stuck with a session the app cannot use: signs out without needing the app to load.
import type { Metadata } from 'next';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { LogoutPage } from '@gitroom/frontend/components/auth/logout.page';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Logout`,
  description: '',
};

// Renders the page that ends the session on load.
export default function LogoutPage() {
  return <LogoutPage />;
}
