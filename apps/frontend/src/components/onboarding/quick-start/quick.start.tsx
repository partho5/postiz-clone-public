'use client';

// Quick start: the three steps from sign-up to a first scheduled post — brand, channel, post —
// resumed after a reload at the first step the server says is unfinished.
import { FC, useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useWorkspaceRouter } from '@gitroom/frontend/components/layout/workspace.navigation';
import { useCurrentBrand } from '@gitroom/frontend/components/brand/profile/use.current.brand';
import { useIntegrationList } from '@gitroom/frontend/components/launches/helpers/use.integration.list';
import type { Integrations } from '@gitroom/frontend/components/launches/calendar.context';
import {
  BRAND_DEFAULT_COLOR,
  BRAND_DEFAULT_TIMEZONE,
} from '@gitroom/nestjs-libraries/dtos/brands/brand.profile.schema';
import { BrandStep } from '@gitroom/frontend/components/onboarding/quick-start/brand.step';
import { ChannelStep } from '@gitroom/frontend/components/onboarding/quick-start/channel.step';
import { PostStep } from '@gitroom/frontend/components/onboarding/quick-start/post.step';
import { clearQuickStartConnect } from '@gitroom/frontend/components/onboarding/quick-start/quick.start.connect';
import { usePostTotal } from '@gitroom/frontend/components/onboarding/quick-start/use.post.total';

// A channel the editor can post to now: switched on and fully connected.
const isUsable = (channel: Integrations) =>
  !channel.disabled && !channel.inBetweenSteps;

// The flow: the step list and the step the server state says is next; nothing left sends the person to the calendar.
export const QuickStart: FC = () => {
  const t = useT();
  const router = useWorkspaceRouter();
  const brand = useCurrentBrand();
  const channels = useIntegrationList();
  const scheduled = usePostTotal('scheduled');
  const published = usePostTotal('published');
  const [brandSaved, setBrandSaved] = useState(false);

  // A connect that came back is over, and one abandoned must not steer a later connect here.
  useEffect(() => {
    clearQuickStartConnect();
    return clearQuickStartConnect;
  }, []);

  const loadFailed = !!(
    brand.error ||
    channels.error ||
    scheduled.error ||
    published.error
  );
  const loading =
    !brand.data ||
    channels.isLoading ||
    scheduled.data === undefined ||
    published.data === undefined;
  const done = (scheduled.data ?? 0) > 0 || (published.data ?? 0) > 0;
  const usable: Integrations[] = (channels.data || []).filter(isUsable);

  // Nothing is left to do: the calendar is where the post is.
  useEffect(() => {
    if (!loading && done) {
      router.push('/launches');
    }
  }, [done, loading, router]);

  // The brand counts as saved when this page saved it or the server holds a value other than the unset defaults.
  const brandDone =
    brandSaved ||
    (channels.data || []).length > 0 ||
    (!!brand.data &&
      (brand.data.timezone !== BRAND_DEFAULT_TIMEZONE ||
        brand.data.color !== BRAND_DEFAULT_COLOR));

  // Re-reads the post counts after the editor saved one.
  const mutateScheduled = scheduled.mutate;
  const mutatePublished = published.mutate;
  const refresh = useCallback(async () => {
    await Promise.all([mutateScheduled(), mutatePublished()]);
  }, [mutateScheduled, mutatePublished]);

  const step = !brandDone ? 1 : !usable.length ? 2 : 3;
  const titles = [
    t('quick_start_step_brand', 'Brand'),
    t('quick_start_step_channel', 'Channel'),
    t('quick_start_step_post', 'Post'),
  ];

  if (loadFailed) {
    return (
      <div className="text-red-400 p-[24px]">
        {t('quick_start_load_failed', 'Failed to load. Reload the page.')}
      </div>
    );
  }

  if (loading || done) {
    return null;
  }

  return (
    <div className="flex flex-col gap-[24px] p-[24px] w-[560px] max-w-full mx-auto text-textColor">
      <h1 className="text-[24px]">{t('quick_start_title', 'Quick start')}</h1>
      <ol className="flex gap-[16px] text-[14px]">
        {titles.map((title, index) => (
          <li
            key={title}
            className={clsx(
              index + 1 === step ? 'text-textColor' : 'text-textItemBlur'
            )}
          >
            {index + 1}. {title}
          </li>
        ))}
      </ol>
      {step === 1 && brand.data && (
        <BrandStep
          brand={brand.data}
          onSaved={(saved) => {
            brand.mutate(saved, { revalidate: false });
            setBrandSaved(true);
          }}
        />
      )}
      {step === 2 && <ChannelStep />}
      {step === 3 && <PostStep channels={usable} onScheduled={refresh} />}
    </div>
  );
};
