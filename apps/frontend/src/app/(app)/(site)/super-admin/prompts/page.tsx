export const dynamic = 'force-dynamic';
import { AdminPromptsComponent } from '@gitroom/frontend/components/admin/admin-prompts.component';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Admin Prompts`,
  description: '',
};

export default async function Page() {
  return (
    <div className="bg-newBgColorInner flex-1 min-w-0 flex-col flex p-[20px] gap-[12px]">
      <AdminPromptsComponent />
    </div>
  );
}
