import { SettingsPopup } from '@gitroom/frontend/components/layout/settings.component';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Settings`,
  description: '',
};
export default async function Index(props: {
  searchParams: Promise<{
    code: string;
  }>;
}) {
  const searchParams = await props.searchParams;
  return <SettingsPopup />;
}
