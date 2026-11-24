// Balance header: the page the header's Reserved number links to.
export const dynamic = 'force-dynamic';
import { ReservedList } from '@gitroom/frontend/components/credits/balance/reserved.list';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: 'Reserved credits',
  description: '',
};
// Renders the list of posts the workspace's reserved credits are held for.
export default async function Page() {
  return (
    <div className="bg-newBgColorInner flex-1 flex-col flex p-[20px] gap-[12px]">
      <ReservedList />
    </div>
  );
}
