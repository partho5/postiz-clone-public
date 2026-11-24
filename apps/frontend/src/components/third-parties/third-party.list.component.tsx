// Feature: Third Party - Provider Directory & API Key Configuration
'use client';

import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import useSWR from 'swr';
import React, { FC, useCallback, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useWorkspaceRouter } from '@gitroom/frontend/components/layout/workspace.navigation';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { FieldValues, FormProvider, useForm } from 'react-hook-form';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';

// Renders form modal allowing users to enter and submit API key credentials.
export const ApiModal: FC<{
  identifier: string;
  title: string;
  update: () => void;
}> = (props) => {
  const { title, identifier, update } = props;
  const fetch = useFetch();
  const router = useWorkspaceRouter();
  const modal = useModals();
  const toaster = useToaster();
  const [loading, setLoading] = useState(false);

  const closePopup = useCallback(() => {
    modal.closeAll();
  }, [modal]);

  const methods = useForm({
    mode: 'onChange',
  });

  const submit = useCallback(
    async (formData: FieldValues) => {
      setLoading(true);
      const add = await fetch(`/third-party/${identifier}`, {
        method: 'POST',
        body: JSON.stringify({
          api: formData.api,
        }),
      });

      if (add.ok) {
        toaster.show('Integration added successfully', 'success');
        if (closePopup) {
          closePopup();
        } else {
          modal.closeAll();
        }
        router.refresh();
        if (update) update();
        return;
      }

      const { message } = await add.json();

      methods.setError('api', {
        message,
      });

      setLoading(false);
    },
    [fetch, identifier, toaster, closePopup, modal, router, update, methods]
  );

  const t = useT();

  return (
    <div className="relative w-full">
      <FormProvider {...methods}>
        <form
          className="gap-[16px] flex flex-col"
          onSubmit={methods.handleSubmit(submit)}
        >
          <div className="pt-[10px]">
            <Input label="API Key" name="api" />
          </div>
          <div className="flex justify-end">
            <Button
              loading={loading}
              type="submit"
              className="w-full sm:w-auto"
            >
              {t('add_integration', 'Add Integration')}
            </Button>
          </div>
        </form>
      </FormProvider>
    </div>
  );
};

// Renders responsive grid of supported third-party providers with integration modal triggers.
export const ThirdPartyListComponent: FC<{ reload: () => void }> = (props) => {
  const fetch = useFetch();
  const modals = useModals();
  const t = useT();
  const { reload } = props;

  // Fetches list of all third-party integrations available to connect.
  const integrationsList = useCallback(async () => {
    return (await fetch('/third-party/list')).json();
  }, [fetch]);

  const { data } = useSWR('third-party-list', integrationsList, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
  });

  // Opens API key entry modal for the selected third-party provider.
  const addApiKey = useCallback(
    (title: string, identifier: string) => () => {
      modals.openModal({
        title: `Add API key for ${title}`,
        withCloseButton: false,
        children: (
          <ApiModal identifier={identifier} title={title} update={reload} />
        ),
      });
    },
    [modals, reload]
  );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-[12px] sm:gap-[16px] min-w-0">
      {data?.map((p: any) => (
        <div
          onClick={addApiKey(p.title, p.identifier)}
          key={p.identifier}
          className="w-full h-full p-[16px] sm:p-[20px] min-h-[140px] text-[14px] bg-newTableHeader hover:bg-newTableBorder rounded-[8px] border border-newTableBorder transition-all text-textColor relative flex flex-col justify-between gap-[12px] sm:gap-[15px] cursor-pointer"
        >
          <div className="flex flex-col gap-[10px] flex-1">
            <div className="w-[32px] h-[32px] shrink-0">
              <img
                className="w-[32px] h-[32px] rounded-full object-contain"
                src={`/icons/third-party/${p.identifier}.png`}
                alt={p.title}
              />
            </div>
            <div className="whitespace-pre-wrap text-left text-base sm:text-lg font-[600]">
              {p.title}
            </div>
            <div className="whitespace-pre-wrap text-left text-[13px] sm:text-[14px] text-textItemBlur line-clamp-3">
              {p.description}
            </div>
          </div>
          <div className="w-full flex pt-[4px]">
            <Button className="w-full">{t('add', 'Add')}</Button>
          </div>
        </div>
      ))}
    </div>
  );
};
