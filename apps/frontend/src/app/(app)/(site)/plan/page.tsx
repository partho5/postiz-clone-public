export const dynamic = 'force-dynamic';
import { ContentPlanComponent } from '@gitroom/frontend/components/content-plan/content.plan.component';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Content plan`,
  description: '',
};
// Renders the brand's AI content plan: its setup, its proposal and the running plan.
export default async function Page() {
  return (
    <div className="bg-newBgColorInner flex-1 min-w-0 flex-col flex p-[20px] gap-[12px]">
      <ContentPlanComponent />
    </div>
  );
}
