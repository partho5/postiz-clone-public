// Activity tracker (api.activity-tracker): /super-admin/activity/[deviceId], the step-by-step replay of one device.
export const dynamic = 'force-dynamic';
import { TrackerReplay } from '@gitroom/frontend/components/admin/tracker/tracker.replay';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Admin Activity Replay`,
  description: '',
};

// Renders the replay of one device. The key makes a move to another device start from a clean state.
export default async function Page(props: {
  params: Promise<{ deviceId: string }>;
}) {
  const params = await props.params;
  return (
    <div className="bg-newBgColorInner flex-1 min-w-0 flex-col flex p-[20px] gap-[12px]">
      <TrackerReplay key={params.deviceId} deviceId={params.deviceId} />
    </div>
  );
}
