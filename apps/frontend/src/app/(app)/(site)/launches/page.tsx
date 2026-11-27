export const dynamic = 'force-dynamic';
import { LaunchesComponent } from '@gitroom/frontend/components/launches/launches.component';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Calendar`,
  description: '',
};
export default async function Index() {
  return <LaunchesComponent />;
}
