export const dynamic = 'force-dynamic';
import { AiCaptionsComponent } from '@gitroom/frontend/components/ai-captions/ai.captions.component';
import { PRODUCT_NAME } from '@gitroom/helpers/brand/brand.identity';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} AI Captions`,
  description: '',
};
// Renders the captions written from the workspace's recordings.
export default async function Page() {
  return (
    <div className="bg-newBgColorInner flex-1 min-w-0 flex-col flex p-[20px] gap-[12px]">
      <AiCaptionsComponent />
    </div>
  );
}
