// Feature: Media Library Responsive Page Layout
'use client';

import { MediaBox } from '@gitroom/frontend/components/media/media.component';

// Renders the standalone media library layout container with responsive padding.
export const MediaLayoutComponent = () => {
  return (
    <div className="bg-newBgColorInner p-[10px] sm:p-[16px] md:p-[20px] flex flex-1 flex-col gap-[15px] transition-all min-h-0">
      <MediaBox setMedia={() => {}} closeModal={() => {}} standalone={true} />
    </div>
  );
};
