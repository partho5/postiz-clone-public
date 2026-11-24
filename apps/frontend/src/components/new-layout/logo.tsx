'use client';
// Feature: brand.rebrand — the product logo mark, taken from the one logo path.
import {
  PRODUCT_LOGO_PATH,
  PRODUCT_NAME,
} from '@gitroom/helpers/brand/brand.identity';

// Renders the product logo image at the menu's mark size.
export const Logo = () => {
  return (
    <img
      src={PRODUCT_LOGO_PATH}
      alt={PRODUCT_NAME}
      width={60}
      height={60}
      className="mt-[8px] min-w-[60px] min-h-[60px] rounded-[12px]"
    />
  );
};
