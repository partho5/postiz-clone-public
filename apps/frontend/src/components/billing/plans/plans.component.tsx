// Feature: Billing Plans & Subscription Management
'use client';

// PayPal subscriptions: the plans screen. It lists the tiers the server returns, marks the
// current one, sends the owner to PayPal to approve, and confirms on return (?subscription_id=…).
// The mobile app's upgrade link opens it on a tier (?tier=…): that card is highlighted, and once the
// plan is confirmed the page says the person may go back to the app.
import React, { FC, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import { Button } from '@gitroom/react/form/button';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useWorkspaceRouter } from '@gitroom/frontend/components/layout/workspace.navigation';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useIdempotencyKey } from '@gitroom/frontend/components/layout/use.idempotency.key';
import { TopupDialog } from '@gitroom/frontend/components/billing/topups/topup.dialog';
import {
  PlanSubscription,
  PlanTier,
  usePlans,
} from '@gitroom/frontend/components/billing/plans/use.plans';

// Remembers, across PayPal's round trip, that the person left for PayPal from the mobile app's upgrade
// link (`?tier=`), so the return, which has no `?tier=`, can say they may go back to the app.
const UPGRADE_TRIP_KEY = 'billing:upgrade';
// A trip that takes longer than this is not the one the link began.
const UPGRADE_TRIP_MAX_AGE_MS = 30 * 60 * 1000;

// The mobile app's launcher as an Android intent URL (MAIN/LAUNCHER, no data); only Android opens it.
const APP_INTENT_URL =
  'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.jovoc.facecampresentationrecorder;end';

// What each app feature is called on a plan card; a feature with no name here is not listed.
const FEATURE_LABELS: Record<string, string> = {
  crop_9_16: 'Vertical 9:16 crop',
  floating_cam: 'Floating camera',
  drawing_board: 'Drawing board',
  slide_ink: 'Ink on slides',
  auto_publish: 'Auto publish',
  crop_4_5: '4:5 crop',
  crop_1_1: 'Square 1:1 crop',
  ai_captions: 'AI captions',
  bg_replace: 'Background replace',
  bg_custom: 'Custom backgrounds',
};

// Records that the person is leaving for PayPal from the app's upgrade link.
const markUpgradeTrip = () => {
  try {
    window.sessionStorage.setItem(UPGRADE_TRIP_KEY, String(Date.now()));
  } catch (e) {}
};

// True when the PayPal trip that just came back began on the app's upgrade link; the record is cleared either way.
const takeUpgradeTrip = () => {
  try {
    const startedAt = Number(window.sessionStorage.getItem(UPGRADE_TRIP_KEY));
    window.sessionStorage.removeItem(UPGRADE_TRIP_KEY);
    return startedAt > 0 && Date.now() - startedAt <= UPGRADE_TRIP_MAX_AGE_MS;
  } catch (e) {
    return false;
  }
};

// A price in cents as the tier's currency writes it.
const formatPrice = (cents: number, currency: string) =>
  (cents / 100).toLocaleString(undefined, { style: 'currency', currency });

// One tier: its name, price, credits and app features, and the action the owner can take on it. The
// card the app's link names is highlighted and brought into view.
const TierCard: FC<{
  tier: PlanTier;
  current: PlanSubscription | null;
  highlighted: boolean;
  busy: boolean;
  onSubscribe: (tier: PlanTier) => void;
  onChange: (tier: PlanTier) => void;
  onCancel: () => void;
}> = ({ tier, current, highlighted, busy, onSubscribe, onChange, onCancel }) => {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const active = current?.status === 'ACTIVE';
  const isCurrent = !!current && current.tierKey === tier.key && active;
  const features = (tier.features ?? []).filter((key) => FEATURE_LABELS[key]);

  // Scrolls to the card the app's link names.
  useEffect(() => {
    if (highlighted) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlighted]);

  return (
    <div
      ref={ref}
      className={clsx(
        'flex flex-col gap-[16px] w-full sm:w-[280px] sm:flex-1 min-w-0 sm:min-w-[220px] bg-newBgColorInner rounded-[12px] p-[20px] border',
        isCurrent ? 'border-btnPrimary' : 'border-newTableBorder',
        highlighted && 'ring-2 ring-btnPrimary'
      )}
    >
      <div className="text-[20px] font-[600]">{tier.name}</div>
      <div className="text-[28px] font-[600]">
        {formatPrice(tier.monthlyPriceCents, tier.currency)}
        <span className="text-[14px] font-[400] text-textItemBlur">
          {' '}
          / {t('month', 'month')}
        </span>
      </div>
      <div className="text-textItemBlur">
        {tier.monthlyCredits} {t('credits_a_month', 'credits a month')}
      </div>
      {features.length > 0 && (
        <ul className="flex flex-col gap-[6px] text-[14px] list-disc ps-[18px]">
          {features.map((key) => (
            <li key={key} className="break-words">
              {t(`plan_feature_${key}`, FEATURE_LABELS[key])}
            </li>
          ))}
        </ul>
      )}
      <div className="flex-1" />
      {isCurrent ? (
        <>
          <div className="text-[14px] text-textItemBlur">
            {t('your_current_plan', 'Your current plan')}
          </div>
          <Button
            secondary={true}
            loading={busy}
            onClick={onCancel}
            className="min-h-[44px] w-full"
          >
            {t('cancel_plan', 'Cancel plan')}
          </Button>
        </>
      ) : active ? (
        <Button
          loading={busy}
          onClick={() => onChange(tier)}
          className="min-h-[44px] w-full"
        >
          {t('switch_to_this_plan', 'Switch to this plan')}
        </Button>
      ) : (
        <Button
          loading={busy}
          onClick={() => onSubscribe(tier)}
          className="min-h-[44px] w-full"
        >
          {t('subscribe', 'Subscribe')}
        </Button>
      )}
    </div>
  );
};

// What the owner is told about the subscription's state, or null when there is nothing to say.
const statusNote = (
  current: PlanSubscription | null,
  t: ReturnType<typeof useT>
) => {
  if (!current) {
    return null;
  }
  if (current.status === 'APPROVAL_PENDING') {
    return t(
      'plan_waiting_for_approval',
      'Your subscription is waiting for your approval at PayPal.'
    );
  }
  if (current.status === 'CANCELLED' && current.currentPeriodEnd) {
    return `${t(
      'plan_ends_on',
      'Your plan is cancelled and stays active until'
    )} ${new Date(current.currentPeriodEnd).toLocaleDateString()}.`;
  }
  if (current.status === 'SUSPENDED' || current.status === 'EXPIRED') {
    return t(
      'plan_not_active',
      'Your subscription is not active. Subscribe again to get your monthly credits.'
    );
  }
  return null;
};

// Tells the person the app has what it needs once the plan is confirmed, with a button back to the app on Android.
const BackToApp: FC = () => {
  const t = useT();
  // the note shows after a request, never in the server's render, so the browser is known here
  const android = /Android/i.test(navigator.userAgent);
  return (
    <div className="flex flex-col items-start gap-[12px] rounded-[12px] border border-btnPrimary p-[16px]">
      <div>{t('plan_done_back_to_app', 'Done. You can go back to the app.')}</div>
      {android && (
        <Button
          secondary={true}
          onClick={() => window.location.assign(APP_INTENT_URL)}
        >
          {t('back_to_the_app', 'Back to the app')}
        </Button>
      )}
    </div>
  );
};

// The plans screen of the billing page: tiers, the current plan and the owner's subscribe, switch and cancel.
export const PlansComponent: FC = () => {
  const t = useT();
  const fetch = useFetch();
  const idempotency = useIdempotencyKey();
  const toaster = useToaster();
  const router = useWorkspaceRouter();
  const modals = useModals();
  const searchParams = useSearchParams();
  const { data, isLoading, mutate } = usePlans();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [backToApp, setBackToApp] = useState(false);
  const confirmed = useRef(false);
  // the tier the mobile app's upgrade link names, in any letter case
  const tierParam = searchParams.get('tier');

  // Sends one plan action to the server; the server's answer, or null after showing why it failed.
  const post = useCallback(
    async (path: string, body?: object) => {
      setBusy(true);
      setMessage(null);
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: {
            'Idempotency-Key': idempotency.key(path + JSON.stringify(body)),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (response.status < 500) {
          idempotency.reset();
        }
        const answer = await response.json();
        if (!response.ok) {
          setMessage(
            answer?.code === 'NOT_ACCOUNT_OWNER'
              ? t(
                  'only_owner_manages_plan',
                  'Only the account owner can manage the plan. Ask the owner to do it.'
                )
              : answer?.message ||
                  t('plan_action_failed', 'This did not work. Try again.')
          );
          return null;
        }
        return answer;
      } finally {
        setBusy(false);
      }
    },
    [fetch, idempotency, t]
  );

  // The owner returned from PayPal: reads the subscription's state once, then clears the address bar.
  // When the plan is active and the trip began on the app's upgrade link, it says the person may go back
  // to the app; the server has written the plan by then, so the app's next refresh sees it.
  useEffect(() => {
    const subscriptionId = searchParams.get('subscription_id');
    if (!subscriptionId || confirmed.current) {
      return;
    }
    confirmed.current = true;
    (async () => {
      const view = await post('/billing/plans/confirm', { subscriptionId });
      if (view?.status === 'ACTIVE') {
        toaster.show(t('plan_active', 'Your plan is active'), 'success');
        if (takeUpgradeTrip() || searchParams.get('tier')) {
          setBackToApp(true);
        }
      }
      await mutate();
      router.replace('/billing');
    })();
  }, [searchParams, post, mutate, router, toaster, t]);

  // Starts a subscription to a tier and sends the owner to PayPal to approve it.
  const subscribe = useCallback(
    async (tier: PlanTier) => {
      const answer = await post('/billing/plans/subscribe', {
        tierKey: tier.key,
      });
      if (answer?.approveUrl) {
        if (tierParam) {
          markUpgradeTrip();
        }
        window.location.assign(answer.approveUrl);
      }
    },
    [post, tierParam]
  );

  // Moves the active subscription to another tier, through PayPal's approval when it asks for one.
  const change = useCallback(
    async (tier: PlanTier) => {
      const answer = await post('/billing/plans/change', { tierKey: tier.key });
      if (!answer) {
        return;
      }
      if (answer.approveUrl) {
        if (tierParam) {
          markUpgradeTrip();
        }
        window.location.assign(answer.approveUrl);
        return;
      }
      toaster.show(
        t('plan_change_next_period', 'Your plan changes from the next billing period'),
        'success'
      );
      await mutate();
    },
    [post, mutate, toaster, t, tierParam]
  );

  // Cancels the subscription after the owner confirms; the plan stays until the paid period ends.
  const cancel = useCallback(async () => {
    if (
      !(await deleteDialog(
        t(
          'cancel_plan_question',
          'Your plan stays active until the end of the period you paid for. Cancel it?'
        ),
        t('yes_cancel', 'Yes, cancel'),
        t('cancel_plan', 'Cancel plan')
      ))
    ) {
      return;
    }
    if (await post('/billing/plans/cancel')) {
      await mutate();
    }
  }, [post, mutate, t]);

  // Opens the credit pack dialog; the server lets only the account owner buy.
  const buyCredits = useCallback(() => {
    modals.openModal({
      title: t('buy_credits', 'Buy credits'),
      children: (close) => <TopupDialog onClose={close} />,
    });
  }, [modals, t]);

  if (isLoading || !data) {
    return <LoadingComponent />;
  }

  const note = statusNote(data.current, t);
  return (
    <div className="flex flex-col gap-[20px]">
      <div className="flex flex-wrap gap-[12px] sm:gap-[16px] items-start sm:items-center justify-between">
        <div className="text-[24px] font-[600]">{t('plans', 'Plans')}</div>
        <Button onClick={buyCredits} className="min-h-[44px] sm:min-h-0">
          {t('buy_credits', 'Buy credits')}
        </Button>
      </div>
      {backToApp && <BackToApp />}
      {note && <div className="text-textItemBlur">{note}</div>}
      {message && <div className="text-red-400">{message}</div>}
      <div className="flex flex-wrap lg:flex-nowrap gap-[16px] sm:gap-[20px]">
        {data.tiers.map((tier) => (
          <TierCard
            key={tier.key}
            tier={tier}
            current={data.current}
            highlighted={
              !!tierParam && tier.key.toLowerCase() === tierParam.toLowerCase()
            }
            busy={busy}
            onSubscribe={subscribe}
            onChange={change}
            onCancel={cancel}
          />
        ))}
      </div>
    </div>
  );
};
