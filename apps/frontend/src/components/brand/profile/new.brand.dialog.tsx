'use client';

// Brand profile: the "New brand" dialog, opened by the brand switcher's "New brand" entry;
// creating a brand ends in a full page load of the new brand's calendar.
import { FC, useCallback, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { workspacePath } from '@gitroom/helpers/utils/workspace.path';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useIdempotencyKey } from '@gitroom/frontend/components/layout/use.idempotency.key';
import { ActionCostNote } from '@gitroom/frontend/components/credits/cost/action.cost.note';
import { useActionCost } from '@gitroom/frontend/components/credits/cost/use.action.cost';
import { BRAND_DEFAULT_COLOR } from '@gitroom/nestjs-libraries/dtos/brands/brand.profile.schema';

// The time zone this browser reports, sent so the brand is created with it.
const detectedTimezone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// The dialog: name, color and detected time zone, and a Create control that shows its cost.
export const NewBrandDialog: FC<{ onClose: () => void }> = ({ onClose }) => {
  const fetch = useFetch();
  const toaster = useToaster();
  const t = useT();
  const idempotency = useIdempotencyKey();
  const cost = useActionCost('brand.create');
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(BRAND_DEFAULT_COLOR);
  const [timezone, setTimezone] = useState(detectedTimezone);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // Creates the brand and loads its calendar; a 402 says the credits are short, a 400 names the field.
  const create = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const body = { name: name.trim(), color, timezone: timezone.trim() };
      const response = await fetch('/brands', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotency.key(JSON.stringify(body)) },
        body: JSON.stringify(body),
      });
      if (response.status < 500) {
        idempotency.reset();
      }
      if (response.status === 402) {
        setError(
          t(
            'brand_not_enough_credits',
            'You do not have enough credits to create a brand.'
          )
        );
        return;
      }
      if (response.status === 400) {
        const answer = await response.json();
        setError(
          (answer.fields as { message: string }[] | undefined)?.[0]?.message ||
            t('brand_invalid', 'Some brand fields are not valid')
        );
        return;
      }
      if (!response.ok) {
        toaster.show(
          t('failed_to_create_brand', 'Failed to create the brand'),
          'warning'
        );
        return;
      }
      const created = await response.json();
      window.location.assign(workspacePath('/launches', created.id));
    } catch {
      toaster.show(
        t('failed_to_create_brand', 'Failed to create the brand'),
        'warning'
      );
    } finally {
      setBusy(false);
    }
  }, [color, fetch, idempotency, name, t, timezone, toaster]);

  return (
    <div className="flex flex-col gap-[8px] p-[24px] w-[420px] max-w-full">
      <h3 className="text-[20px]">{t('new_brand', 'New brand')}</h3>
      <Input
        label={t('brand_name', 'Name')}
        name="newBrandName"
        disableForm={true}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="flex flex-col gap-[6px]">
        <div className="text-[14px]">{t('brand_color', 'Color')}</div>
        <input
          type="color"
          aria-label={t('brand_color', 'Color')}
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="h-[42px] w-[80px] bg-transparent"
        />
      </div>
      <Input
        label={t('brand_timezone', 'Time zone')}
        name="newBrandTimezone"
        disableForm={true}
        value={timezone}
        onChange={(e) => setTimezone(e.target.value)}
      />
      {!!error && <div className="text-red-400 text-[12px]">{error}</div>}
      <ActionCostNote
        actionKey="brand.create"
        label={t('brand_create_cost', 'Creating a brand')}
      />
      <div className="flex gap-[8px] mt-[8px]">
        <Button
          onClick={create}
          loading={busy}
          disabled={!name.trim() || !cost.data}
        >
          {t('create_brand', 'Create brand')}
        </Button>
        <Button secondary={true} onClick={onClose}>
          {t('cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  );
};
