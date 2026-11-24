'use client';

// Brand switcher: the header badge naming the brand this tab is in, with its colour and avatar.
import React, { FC } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useCurrentBrand } from '@gitroom/frontend/components/brand/profile/use.current.brand';
import { BrandAvatar } from '@gitroom/frontend/components/brand/switcher/brand.avatar';

// The current brand's avatar and name with an accent in its colour, as a button that opens the palette;
// `compact` keeps the avatar and the chevron only. Nothing until the server has answered.
export const BrandBadge: FC<{ onClick: () => void; compact?: boolean }> = ({
  onClick,
  compact,
}) => {
  const t = useT();
  const { data } = useCurrentBrand();
  if (!data) {
    return null;
  }
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label={t('switch_brand', 'Switch brand')}
        title={t('brand_switch_hint', 'Switch brand (Ctrl+K)')}
        style={{ borderBottomColor: data.color }}
        className="flex items-center gap-[8px] border-b-[2px] pb-[2px] hover:text-newTextColor"
      >
        <BrandAvatar
          name={data.name}
          color={data.color}
          avatarUrl={data.avatarUrl}
        />
        {!compact && (
          <div className="max-w-[240px] truncate text-[14px]">{data.name}</div>
        )}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <div className="w-[1px] h-[20px] bg-blockSeparator" />
    </>
  );
};
