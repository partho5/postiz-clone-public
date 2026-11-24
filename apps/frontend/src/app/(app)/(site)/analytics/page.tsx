export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { PlatformAnalytics } from '@gitroom/frontend/components/platform-analytics/platform.analytics';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Analytics`,
  description: '',
};
export default async function Index() {
  return <PlatformAnalytics />;
}
