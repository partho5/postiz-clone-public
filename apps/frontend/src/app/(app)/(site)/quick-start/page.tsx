export const dynamic = 'force-dynamic';
import { QuickStart } from '@gitroom/frontend/components/onboarding/quick-start/quick.start';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Quick start`,
  description: '',
};
export default async function Index() {
  return <QuickStart />;
}
