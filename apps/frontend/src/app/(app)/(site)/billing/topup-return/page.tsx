// PayPal top-ups: the route PayPal returns the buyer to after approving a credit pack.
export const dynamic = 'force-dynamic';
import { TopupReturn } from '@gitroom/frontend/components/billing/topups/topup.return';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Billing`,
  description: '',
};
// Renders the top-up return screen that captures the approved order and shows the result.
export default async function Page() {
  return (
    <div className="bg-newBgColorInner flex-1 flex-col flex p-[20px] gap-[12px]">
      <TopupReturn />
    </div>
  );
}
