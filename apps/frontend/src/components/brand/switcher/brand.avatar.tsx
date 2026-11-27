'use client';

// Brand switcher: a brand's avatar, or its initials on its colour when it has none.
import React, { FC } from 'react';

// The first letters of the first two words of a brand's name.
export const brandInitials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toUpperCase();

// The round avatar of a brand: its picture, or initials on the brand colour.
export const BrandAvatar: FC<{
  name: string;
  color: string;
  avatarUrl: string | null;
  size?: number;
}> = ({ name, color, avatarUrl, size = 28 }) => {
  const box = { width: size, height: size };
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        style={box}
        className="rounded-full object-cover shrink-0"
      />
    );
  }
  return (
    <div
      style={{ ...box, backgroundColor: color }}
      className="rounded-full shrink-0 flex items-center justify-center text-white text-[11px] font-[600]"
    >
      {brandInitials(name)}
    </div>
  );
};
