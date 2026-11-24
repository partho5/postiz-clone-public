// Legal pages: the shared column and header of the Terms, Privacy and data-deletion pages.
import { ReactNode } from 'react';
import {
  PRODUCT_LOGO_PATH,
  PRODUCT_NAME,
} from '@gitroom/helpers/brand/brand.identity';

// Wraps a legal page in a readable column under the product name; needs no session and calls no API.
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-newBgColor min-h-screen text-newTextColor">
      <div className="max-w-[760px] mx-auto px-[20px] py-[40px] flex flex-col gap-[24px]">
        <a href="/" className="flex items-center gap-[12px] w-fit">
          <img
            src={PRODUCT_LOGO_PATH}
            alt={PRODUCT_NAME}
            width={36}
            height={36}
            className="rounded-[8px]"
          />
          <span className="text-[18px] font-semibold">{PRODUCT_NAME}</span>
        </a>
        <main className="flex flex-col gap-[20px] text-[15px] leading-[24px]">
          {children}
        </main>
      </div>
    </div>
  );
}
