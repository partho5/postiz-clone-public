import { ThirdPartyComponent } from '@gitroom/frontend/components/third-parties/third-party.component';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';

export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Integrations`,
  description: '',
};
export default async function Index() {
  return <ThirdPartyComponent />;
}
