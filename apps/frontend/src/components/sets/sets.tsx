// Feature: Social Sets and Channel Grouping Management
'use client';
import 'reflect-metadata';

import React, { FC, Fragment, useCallback, useMemo, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import useSWR from 'swr';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { Select } from '@gitroom/react/form/select';
import { useToaster } from '@gitroom/react/toaster/toaster';
import clsx from 'clsx';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { AddEditModal } from '@gitroom/frontend/components/new-launch/add.edit.modal';
import { newDayjs } from '@gitroom/frontend/components/layout/set.timezone';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';

const SaveSetModal: FC<{
  postData: any;
  initialValue?: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}> = ({ postData, onSave, onCancel, initialValue }) => {
  const [name, setName] = useState(initialValue);
  const t = useT();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onSave(name.trim());
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <Input
          label="Set Name"
          translationKey="label_set_name"
          name="setName"
          value={name}
          disableForm={true}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter a name for this set"
          autoFocus
        />
      </div>
      <div className="flex gap-2 justify-end">
        <Button type="button" secondary onClick={onCancel}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" disabled={!name.trim()}>
          {t('save', 'Save')}
        </Button>
      </div>
    </form>
  );
};

type AutoPublishTiming = 'now' | 'next_slot';

// The Set the workspace's mobile app publishes new recordings with, and when; null when none is chosen
// (the app then publishes in automatic mode: every supported channel with default settings).
const useAutoPublishPreset = () => {
  const fetch = useFetch();
  const load = useCallback(async () => {
    return (await (await fetch('/auto-publish')).json()).preset as {
      setId: string;
      setName: string;
      timing: AutoPublishTiming;
    } | null;
  }, []);

  return useSWR('auto-publish-preset', load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
  });
};

export const Sets: FC = () => {
  const fetch = useFetch();
  const user = useUser();
  const modal = useModals();
  const toaster = useToaster();

  const load = useCallback(async (path: string) => {
    return (await (await fetch(path)).json()).integrations;
  }, []);

  const { isLoading, data: integrations } = useSWR('/integrations/list', load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    fallbackData: [],
  });

  const list = useCallback(async () => {
    return (await fetch('/sets')).json();
  }, []);

  const { data, mutate } = useSWR('sets', list, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
  });

  const { data: preset, mutate: mutatePreset } = useAutoPublishPreset();

  // Makes a Set the workspace's mobile auto-publish preset (or changes its timing).
  const choosePreset = useCallback(
    (setId: string, timing: AutoPublishTiming) => async () => {
      try {
        await fetch('/auto-publish', {
          method: 'PUT',
          body: JSON.stringify({ setId, timing }),
        });
        await mutatePreset();
        toaster.show('Mobile auto-publish updated', 'success');
      } catch (error) {
        toaster.show('Failed to update mobile auto-publish', 'warning');
      }
    },
    []
  );

  // Stops using the Set for mobile auto-publish (the app goes back to automatic mode).
  const clearPreset = useCallback(async () => {
    try {
      await fetch('/auto-publish', { method: 'DELETE' });
      await mutatePreset();
      toaster.show('Mobile auto-publish no longer uses this Set', 'success');
    } catch (error) {
      toaster.show('Failed to update mobile auto-publish', 'warning');
    }
  }, []);

  const addSet = useCallback(
    (params?: { id?: string; name?: string; content?: string }) => () => {
      modal.openModal({
        id: 'add-edit-modal',
        closeOnClickOutside: false,
        removeLayout: true,
        closeOnEscape: false,
        withCloseButton: false,
        askClose: true,
        fullScreen: true,
        classNames: {
          modal: 'w-[100%] max-w-[1400px] text-textColor',
        },
        children: (
          <AddEditModal
            allIntegrations={integrations.map((p: any) => ({
              ...p,
            }))}
            {...(params?.id ? { set: JSON.parse(params.content) } : {})}
            addEditSets={(data) => {
              modal.openModal({
                title: 'Save as Set',
                children: (
                  <SaveSetModal
                    initialValue={params?.name || ''}
                    postData={data}
                    onSave={async (name: string) => {
                      try {
                        await fetch('/sets', {
                          method: 'POST',
                          body: JSON.stringify({
                            ...(params?.id ? { id: params.id } : {}),
                            name,
                            content: JSON.stringify(data),
                          }),
                        });
                        modal.closeAll();
                        mutate();
                        toaster.show('Set saved successfully', 'success');
                      } catch (error) {
                        toaster.show('Failed to save set', 'warning');
                      }
                    }}
                    onCancel={() => modal.closeAll()}
                  />
                ),
              });
            }}
            reopenModal={() => {}}
            mutate={() => {}}
            integrations={integrations}
            date={newDayjs()}
          />
        ),
        title: ``,
      });
    },
    [integrations]
  );

  const deleteSet = useCallback(
    (data: any) => async () => {
      if (await deleteDialog(`Are you sure you want to delete ${data.name}?`)) {
        await fetch(`/sets/${data.id}`, {
          method: 'DELETE',
        });
        mutate();
        mutatePreset();
        toaster.show('Set deleted successfully', 'success');
      }
    },
    []
  );

  const t = useT();

  return (
    <div className="flex flex-col">
      <h3 className="text-[20px]">Sets ({data?.length || 0})</h3>
      <div className="text-customColor18 mt-[4px]">
        Manage your content sets for easy reuse across posts.
      </div>
      <div className="text-textItemBlur mt-[4px]">
        {t(
          'mobile_auto_publish_set_hint',
          'Without a Set, the mobile app publishes every recording to all your supported channels with default settings. A Set marked for mobile auto-publish replaces that: its channels, text and settings are used instead. Its text may contain {title}, which is replaced by the recording name.'
        )}
      </div>
      <div className="my-[16px] mt-[16px] bg-sixth border-fifth items-center border rounded-[4px] p-[16px] sm:p-[24px] flex gap-[24px]">
        <div className="flex flex-col w-full min-w-0">
          {!!data?.length && (
            <div className="overflow-x-auto min-w-0 w-full scrollbar-none">
              <div className="grid grid-cols-[2fr,2fr,1fr,1fr] min-w-[560px] w-full gap-y-[10px]">
                <div>{t('name', 'Name')}</div>
                <div>{t('mobile_auto_publish', 'Mobile auto-publish')}</div>
                <div>{t('edit', 'Edit')}</div>
                <div>{t('delete', 'Delete')}</div>
                {data?.map((p: any) => (
                  <Fragment key={p.id}>
                    <div className="flex flex-col justify-center">{p.name}</div>
                    <div className="flex flex-col justify-center">
                      {preset?.setId === p.id ? (
                        <div className="flex items-center gap-[8px]">
                          <span className="text-[12px] font-[600]">
                            {t('auto_publish_active', 'Active')}
                          </span>
                          <Select
                            label=""
                            name="autoPublishTiming"
                            disableForm={true}
                            hideErrors={true}
                            value={preset.timing}
                            onChange={(e) =>
                              choosePreset(
                                p.id,
                                e.target.value as AutoPublishTiming
                              )()
                            }
                          >
                            <option value="now">
                              {t('auto_publish_now', 'Publish now')}
                            </option>
                            <option value="next_slot">
                              {t('auto_publish_next_slot', 'Next free slot')}
                            </option>
                          </Select>
                          <Button secondary onClick={clearPreset}>
                            {t('auto_publish_stop_using', 'Stop using')}
                          </Button>
                        </div>
                      ) : (
                        <div>
                          <Button onClick={choosePreset(p.id, 'now')}>
                            {t(
                              'use_for_mobile_auto_publish',
                              'Use for mobile auto-publish'
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col justify-center">
                      <div>
                        <Button onClick={addSet(p)}>{t('edit', 'Edit')}</Button>
                      </div>
                    </div>
                    <div className="flex flex-col justify-center">
                      <div>
                        <Button onClick={deleteSet(p)}>
                          {t('delete', 'Delete')}
                        </Button>
                      </div>
                    </div>
                  </Fragment>
                ))}
              </div>
            </div>
          )}
          <div>
            <Button
              onClick={addSet()}
              className={clsx((data?.length || 0) > 0 && 'my-[16px]', 'min-h-[44px] w-full sm:w-auto')}
            >
              Add a set
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
