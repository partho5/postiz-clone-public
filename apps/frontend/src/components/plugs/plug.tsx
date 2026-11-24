// Feature: Plugs - Plug Automation Cards & Configuration Modal
'use client';

import {
  PlugSettings,
  PlugsInterface,
  usePlugs,
} from '@gitroom/frontend/components/plugs/plugs.context';
import { Button } from '@gitroom/react/form/button';
import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import useSWR from 'swr';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import {
  FormProvider,
  SubmitHandler,
  useForm,
  useFormContext,
} from 'react-hook-form';
import { Input } from '@gitroom/react/form/input';
import { CopilotTextarea } from '@copilotkit/react-textarea';
import clsx from 'clsx';
import { string, object } from 'yup';
import { yupResolver } from '@hookform/resolvers/yup';
import { Slider } from '@gitroom/react/form/slider';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

// Reconstructs a RegExp object from a serialized pattern string.
export function convertBackRegex(s: string) {
  const matches = s.match(/\/(.*)\/([a-z]*)/);
  const pattern = matches?.[1] || '';
  const flags = matches?.[2] || '';
  return new RegExp(pattern, flags);
}

// Renders a rich CopilotTextarea form field with validation error display.
export const TextArea: FC<{
  name: string;
  placeHolder: string;
}> = (props) => {
  const form = useFormContext();
  const { onChange, onBlur, ...all } = form.register(props.name);
  const value = form.watch(props.name);
  return (
    <>
      <textarea className="hidden" {...all}></textarea>
      <CopilotTextarea
        disableBranding={true}
        placeholder={props.placeHolder}
        value={value}
        className={clsx(
          '!min-h-40 !max-h-80 p-[16px] sm:p-[24px] overflow-hidden bg-customColor2 outline-none rounded-[4px] border-fifth border w-full'
        )}
        onChange={(e) => {
          onChange({
            target: {
              name: props.name,
              value: e.target.value,
            },
          });
        }}
        autosuggestionsConfig={{
          textareaPurpose: `Assist me in writing social media posts.`,
          chatApiConfigs: {},
        }}
      />
      <div className="text-red-400 text-[12px]">
        {form?.formState?.errors?.[props.name]?.message as string}
      </div>
    </>
  );
};

// Renders modal form allowing users to configure and activate plug properties.
export const PlugPop: FC<{
  plug: PlugsInterface;
  settings: PlugSettings;
  data?: {
    activated: boolean;
    data: string;
    id: string;
    integrationId: string;
    organizationId: string;
    plugFunction: string;
  };
}> = (props) => {
  const { plug, settings, data } = props;
  const { closeAll } = useModals();
  const fetch = useFetch();
  const toaster = useToaster();
  const values = useMemo(() => {
    if (!data?.data) {
      return {};
    }
    return JSON.parse(data.data).reduce((acc: any, current: any) => {
      return {
        ...acc,
        [current.name]: current.value,
      };
    }, {} as any);
  }, []);
  const yupSchema = useMemo(() => {
    return object(
      plug.fields.reduce((acc, field) => {
        return {
          ...acc,
          [field.name]: field.validation
            ? string().matches(convertBackRegex(field.validation), {
                message: 'Invalid value',
              })
            : null,
        };
      }, {})
    );
  }, []);
  const form = useForm({
    resolver: yupResolver(yupSchema),
    values,
    mode: 'all',
  });
  const submit: SubmitHandler<any> = useCallback(async (formData) => {
    await fetch(`/integrations/${settings.providerId}/plugs`, {
      method: 'POST',
      body: JSON.stringify({
        func: plug.methodName,
        fields: Object.keys(formData).map((key) => ({
          name: key,
          value: formData[key],
        })),
      }),
    });
    toaster.show('Plug updated', 'success');
    closeAll();
  }, []);

  const t = useT();

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="w-full">
        <div className="relative mx-auto w-full">
          <div className="my-[16px] sm:my-[20px] text-[14px] text-textItemBlur">
            {plug.description}
          </div>
          <div className="flex flex-col gap-[12px]">
            {plug.fields.map((field) => (
              <div key={field.name} className="flex flex-col gap-[4px]">
                {field.type === 'richtext' ? (
                  <TextArea name={field.name} placeHolder={field.placeholder} />
                ) : (
                  <Input
                    name={field.name}
                    label={field.description}
                    className="w-full mt-[4px] p-[8px] border border-tableBorder rounded-md text-black"
                    placeholder={field.placeholder}
                    type={field.type}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="mt-[20px] flex justify-end">
            <Button type="submit" className="w-full sm:w-auto">
              {t('activate', 'Activate')}
            </Button>
          </div>
        </div>
      </form>
    </FormProvider>
  );
};

// Displays a single automation plug card with activation toggle and edit button.
export const PlugItem: FC<{
  plug: PlugsInterface;
  addPlug: (data: any) => void;
  data?: {
    activated: boolean;
    data: string;
    id: string;
    integrationId: string;
    organizationId: string;
    plugFunction: string;
  };
}> = (props) => {
  const { plug, addPlug, data } = props;
  const [activated, setActivated] = useState(!!data?.activated);
  useEffect(() => {
    setActivated(!!data?.activated);
  }, [data?.activated]);
  const fetch = useFetch();
  const changeActivated = useCallback(
    async (status: 'on' | 'off') => {
      await fetch(`/integrations/plugs/${data?.id}/activate`, {
        body: JSON.stringify({
          status: status === 'on',
        }),
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      setActivated(status === 'on');
    },
    [activated, data?.id]
  );

  return (
    <div
      onClick={() => addPlug(data)}
      key={plug.title}
      className="w-full min-h-[240px] rounded-[8px] bg-newTableHeader hover:bg-newTableBorder transition-all cursor-pointer border border-newTableBorder flex flex-col justify-between"
    >
      <div
        key={plug.title}
        className="p-[16px] h-full flex flex-col flex-1 justify-between gap-[12px]"
      >
        <div className="flex items-start justify-between gap-[10px]">
          <div className="text-[18px] sm:text-[20px] font-[600] flex-1 line-clamp-2">
            {plug.title}
          </div>
          {!!data && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 pt-[2px]"
            >
              <Slider
                value={activated ? 'on' : 'off'}
                onChange={changeActivated}
                fill={true}
              />
            </div>
          )}
        </div>
        <div className="flex-1 text-[14px] text-textItemBlur line-clamp-4">
          {plug.description}
        </div>
        <div className="pt-[4px]">
          <Button className="w-full">{!data ? 'Set Plug' : 'Edit Plug'}</Button>
        </div>
      </div>
    </div>
  );
};

// Renders the responsive grid of available automation plugs for the active channel.
export const Plug = () => {
  const plug = usePlugs();
  const modals = useModals();
  const fetch = useFetch();
  const load = useCallback(async () => {
    return (await fetch(`/integrations/${plug.providerId}/plugs`)).json();
  }, [plug.providerId]);
  const { data, isLoading, mutate } = useSWR(`plugs-${plug.providerId}`, load);

  const addEditPlug = useCallback(
    (p: PlugsInterface) =>
      (itemData?: {
        activated: boolean;
        data: string;
        id: string;
        integrationId: string;
        organizationId: string;
        plugFunction: string;
      }) => {
        modals.openModal({
          withCloseButton: false,
          onClose() {
            mutate();
          },
          size: '500px',
          title: `Auto Plug: ${p.title}`,
          children: (
            <PlugPop
              plug={p}
              data={itemData}
              settings={{
                identifier: plug.identifier,
                providerId: plug.providerId,
                name: plug.name,
              }}
            />
          ),
        });
      },
    [plug, modals, mutate]
  );

  if (isLoading) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[16px] sm:gap-[20px] lg:gap-[30px] min-w-0">
      {plug.plugs.map((p) => (
        <PlugItem
          key={p.title + '-' + plug.providerId}
          addPlug={addEditPlug(p)}
          plug={p}
          data={data?.find((a: any) => a.plugFunction === p.methodName)}
        />
      ))}
    </div>
  );
};
