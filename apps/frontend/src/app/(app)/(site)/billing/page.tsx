export const dynamic = 'force-dynamic';
import { PlansComponent } from '@gitroom/frontend/components/billing/plans/plans.component';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Billing`,
  description: '',
};
export default async function Page() {
  return (
    <div className="bg-newBgColorInner flex-1 flex-col flex p-[20px] gap-[12px]">
      <PlansComponent />
    </div>
  );
}
