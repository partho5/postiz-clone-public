'use client';

// Cost preview: "N credits" for a cost the server stated; nothing for a free action, a pending
// mark while the cost is being asked.
import React, { FC } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

// The cost as text; undefined is "not known yet", 0 is free and shows nothing.
export const CostLabel: FC<{ amount: number | undefined }> = ({ amount }) => {
  const t = useT();
  if (amount === undefined) {
    return <span className="text-textItemBlur">…</span>;
  }
  if (amount === 0) {
    return null;
  }
  return (
    <span>
      {amount} {amount === 1 ? t('credit', 'credit') : t('credits', 'credits')}
    </span>
  );
};
