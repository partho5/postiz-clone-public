// Activity tracker (api.activity-tracker): /super-admin/activity, the Activity tab of the super admin area.
export const dynamic = 'force-dynamic';
import { TrackerHome } from '@gitroom/frontend/components/admin/tracker/tracker.home';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Admin Activity`,
  description: '',
};

export default async function Page() {
  return (
    <div className="bg-newBgColorInner flex-1 min-w-0 flex-col flex p-[20px] gap-[12px]">
      <TrackerHome />
    </div>
  );
}
