import { MediaLayoutComponent } from '@gitroom/frontend/components/new-layout/layout.media.component';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Media`,
  description: '',
};

export default async function Page() {
  return <MediaLayoutComponent />
}
