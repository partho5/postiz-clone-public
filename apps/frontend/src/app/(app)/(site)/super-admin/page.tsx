export const dynamic = 'force-dynamic';
import { SuperAdminOverview } from '@gitroom/frontend/components/super-admin/super.admin.overview';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Super Admin`,
  description: '',
};

export default async function Page() {
  return (
    <div className="bg-newBgColorInner flex-1 min-w-0 flex-col flex p-[20px] gap-[12px]">
      <SuperAdminOverview />
    </div>
  );
}
