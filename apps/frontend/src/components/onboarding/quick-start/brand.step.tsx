'use client';

// Quick start, step 1: the sign-up workspace's brand name, color and detected time zone, saved
// through the brand profile route.
import { FC, useCallback, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useIdempotencyKey } from '@gitroom/frontend/components/layout/use.idempotency.key';
import {
  BRAND_DEFAULT_TIMEZONE,
  BrandView,
} from '@gitroom/nestjs-libraries/dtos/brands/brand.profile.schema';

// The time zone this browser reports; the brand's own when it already has one.
const initialTimezone = (brand: BrandView) =>
  brand.timezone !== BRAND_DEFAULT_TIMEZONE
    ? brand.timezone
    : Intl.DateTimeFormat().resolvedOptions().timeZone ||
      BRAND_DEFAULT_TIMEZONE;

// The form: name (prefilled), color and time zone (detected); Continue saves them and hands the brand back.
export const BrandStep: FC<{
  brand: BrandView;
  onSaved: (brand: BrandView) => void;
}> = ({ brand, onSaved }) => {
  const fetch = useFetch();
  const toaster = useToaster();
  const t = useT();
  const idempotency = useIdempotencyKey();
  const [name, setName] = useState(brand.name);
  const [color, setColor] = useState(brand.color);
  const [timezone, setTimezone] = useState(() => initialTimezone(brand));
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // Saves the brand; a 400 names the field, a 403 says who may change it.
  const save = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const body = { name: name.trim(), color, timezone: timezone.trim() };
      const response = await fetch('/brands/current', {
        method: 'PUT',
        headers: { 'Idempotency-Key': idempotency.key(JSON.stringify(body)) },
        body: JSON.stringify(body),
      });
      if (response.status < 500) {
        idempotency.reset();
      }
      if (response.status === 400) {
        const answer = await response.json();
        setError(
          (answer.fields as { message: string }[] | undefined)?.[0]?.message ||
            t('brand_invalid', 'Some brand fields are not valid')
        );
        return;
      }
      if (response.status === 403) {
        setError(
          t(
            'quick_start_brand_forbidden',
            'Only an admin of this brand can change it.'
          )
        );
        return;
      }
      if (!response.ok) {
        toaster.show(
          t('failed_to_save_brand', 'Failed to save the brand'),
          'warning'
        );
        return;
      }
      onSaved(await response.json());
    } catch {
      toaster.show(
        t('failed_to_save_brand', 'Failed to save the brand'),
        'warning'
      );
    } finally {
      setBusy(false);
    }
  }, [color, fetch, idempotency, name, onSaved, t, timezone, toaster]);

  return (
    <div className="flex flex-col gap-[8px]">
      <h2 className="text-[18px]">
        {t('quick_start_brand_title', 'Name your brand')}
      </h2>
      <Input
        label={t('brand_name', 'Name')}
        name="quickStartBrandName"
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
        name="quickStartBrandTimezone"
        disableForm={true}
        value={timezone}
        onChange={(e) => setTimezone(e.target.value)}
      />
      {!!error && <div className="text-red-400 text-[12px]">{error}</div>}
      <div className="flex gap-[8px] mt-[8px]">
        <Button onClick={save} loading={busy} disabled={!name.trim()}>
          {t('quick_start_continue', 'Continue')}
        </Button>
      </div>
    </div>
  );
};
