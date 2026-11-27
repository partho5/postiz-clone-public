import { Plugs } from '@gitroom/frontend/components/plugs/plugs';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Plugs`,
  description: '',
};
export default async function Index() {
  return <Plugs />;
}
