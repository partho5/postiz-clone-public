// Feature: brand.rebrand — the product logo with its name, taken from the brand identity.
import React from 'react';
import {
  PRODUCT_LOGO_PATH,
  PRODUCT_NAME,
} from '@gitroom/helpers/brand/brand.identity';

// Renders the logo mark followed by the product name.
export const LogoTextComponent = () => {
  return (
    <div className="flex items-center gap-[10px]">
      <img
        src={PRODUCT_LOGO_PATH}
        alt={PRODUCT_NAME}
        width={33}
        height={33}
        className="rounded-[8px]"
      />
      <span className="text-[22px] font-[600] text-current">
        {PRODUCT_NAME}
      </span>
    </div>
  );
};
