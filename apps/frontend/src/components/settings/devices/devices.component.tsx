// Feature: Device Sessions and Sign-Out Management
'use client';

// Device sessions: the Settings "Devices" tab, listing signed-in devices and signing them out.
import { FC, useCallback } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  DeviceSession,
  useSessions,
} from '@gitroom/frontend/components/settings/devices/use.sessions';

// A short label for a device: its own name, else the browser and system its user agent names.
const deviceLabel = (session: DeviceSession, unknown: string) => {
  if (session.name) {
    return session.name;
  }
  const agent = session.userAgent || '';
  const browser = ['Edg', 'OPR', 'Firefox', 'Chrome', 'Safari'].find((b) =>
    agent.includes(b + '/')
  );
  const system = ['Android', 'iPhone', 'iPad', 'Windows', 'Mac OS', 'Linux'].find(
    (s) => agent.includes(s)
  );
  const names: Record<string, string> = { Edg: 'Edge', OPR: 'Opera' };
  const label = [browser && (names[browser] || browser), system]
    .filter(Boolean)
    .join(' · ');
  return label || unknown;
};

// The Devices tab: one row per signed-in device with "Sign out", and "Sign out all other devices".
export const DevicesComponent: FC = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const t = useT();
  const { data: sessions, mutate } = useSessions();

  // Signs one device out after confirmation; signing out this device logs the tab out via the server's answer.
  const signOut = useCallback(
    (session: DeviceSession) => async () => {
      if (
        await deleteDialog(
          t(
            'are_you_sure_sign_out_device',
            'Are you sure you want to sign this device out?'
          ),
          t('yes_sign_out', 'Yes, sign out')
        )
      ) {
        try {
          await fetch(`/auth/sessions/${session.id}`, { method: 'DELETE' });
          toaster.show(t('device_signed_out', 'Device signed out'), 'success');
          mutate();
        } catch {
          toaster.show(
            t('failed_to_sign_out_device', 'Failed to sign the device out'),
            'warning'
          );
        }
      }
    },
    [fetch, mutate, t, toaster]
  );

  // Signs every device but this one out after confirmation.
  const signOutOthers = useCallback(async () => {
    if (
      await deleteDialog(
        t(
          'are_you_sure_sign_out_others',
          'Are you sure you want to sign out all other devices?'
        ),
        t('yes_sign_out', 'Yes, sign out')
      )
    ) {
      try {
        await fetch('/auth/sessions?except=current', { method: 'DELETE' });
        toaster.show(
          t('other_devices_signed_out', 'Other devices signed out'),
          'success'
        );
        mutate();
      } catch {
        toaster.show(
          t('failed_to_sign_out_devices', 'Failed to sign the devices out'),
          'warning'
        );
      }
    }
  }, [fetch, mutate, t, toaster]);

  if (sessions === undefined) {
    return null;
  }

  return (
    <div className="flex flex-col gap-[20px]">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-[12px]">
        <div className="flex flex-col">
          <h3 className="text-[20px]">{t('devices', 'Devices')}</h3>
          <div className="text-customColor18 mt-[4px]">
            {t(
              'devices_you_are_signed_in_on',
              'The devices you are signed in on.'
            )}
          </div>
        </div>
        {sessions.some((session) => !session.current) && (
          <Button onClick={signOutOthers} className="min-h-[44px] w-full sm:w-auto">
            {t('sign_out_all_other_devices', 'Sign out all other devices')}
          </Button>
        )}
      </div>

      <div className="bg-sixth border-fifth border rounded-[4px] p-[16px] sm:p-[24px]">
        <div className="flex flex-col gap-[16px]">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-[12px] sm:gap-[8px] p-[12px] border border-fifth rounded-[4px]"
            >
              <div className="flex flex-col min-w-0">
                <div className="text-[14px] font-bold">
                  {deviceLabel(session, t('unknown_device', 'Unknown device'))}
                  {session.current && (
                    <span className="ms-[8px] text-[12px] text-customColor18 font-normal">
                      {t('this_device', 'This device')}
                    </span>
                  )}
                </div>
                {!!session.ip && (
                  <div className="text-customColor18 text-[12px]">
                    {t('ip_address', 'IP address')} {session.ip}
                  </div>
                )}
                <div className="text-customColor18 text-[12px]">
                  {t('signed_in_on', 'Signed in')}{' '}
                  {new Date(session.createdAt).toLocaleString()}
                </div>
                <div className="text-customColor18 text-[12px]">
                  {t('last_seen', 'Last seen')}{' '}
                  {new Date(session.lastSeenAt).toLocaleString()}
                </div>
              </div>
              <Button onClick={signOut(session)} className="min-h-[44px] w-full sm:w-auto shrink-0">
                {t('sign_out', 'Sign out')}
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
