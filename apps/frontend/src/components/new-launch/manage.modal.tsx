// Feature: Post Creation and Editor Modal (ManageModal)

'use client';

import React, {
  FC,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AddEditModalProps } from '@gitroom/frontend/components/new-launch/add.edit.modal';
import clsx from 'clsx';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { PicksSocialsComponent } from '@gitroom/frontend/components/new-launch/picks.socials.component';
import { EditorWrapper } from '@gitroom/frontend/components/new-launch/editor';
import { SelectCurrent } from '@gitroom/frontend/components/new-launch/select.current';
import { ShowAllProviders } from '@gitroom/frontend/components/new-launch/providers/show.all.providers';
import { useExistingData } from '@gitroom/frontend/components/launches/helpers/use.existing.data';
import { useLaunchStore } from '@gitroom/frontend/components/new-launch/store';
import { DatePicker } from '@gitroom/frontend/components/launches/helpers/date.picker';
import { useShallow } from 'zustand/react/shallow';
import { RepeatComponent } from '@gitroom/frontend/components/launches/repeat.component';
import { TagsComponent } from '@gitroom/frontend/components/launches/tags.component';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { capitalize } from 'lodash';
import { SelectCustomer } from '@gitroom/frontend/components/launches/select.customer';
import { CopilotPopup } from '@copilotkit/react-ui';
import { DummyCodeComponent } from '@gitroom/frontend/components/new-launch/dummy.code.component';
import { CreationMethodBadge } from '@gitroom/frontend/components/launches/creation.method.badge';
import {
  SettingsIcon,
  ChevronDownIcon,
  CloseIcon,
  TrashIcon,
  DropdownArrowSmallIcon,
} from '@gitroom/frontend/components/ui/icons';
import { useHasScroll } from '@gitroom/frontend/components/ui/is.scroll.hook';
import { useShortlinkPreference } from '@gitroom/frontend/components/settings/shortlink-preference.component';
import dayjs from 'dayjs';
import { Button } from '@gitroom/react/form/button';
import { usePublishCostButton } from '@gitroom/frontend/components/credits/cost/use.publish.cost';
import { Input as AssistantInput } from '@gitroom/frontend/components/agents/agent.input';
import { useIdempotencyKey } from '@gitroom/frontend/components/layout/use.idempotency.key';

// Main modal composer managing multi-channel post authoring, live preview, scheduling, and validation.
export const ManageModal: FC<AddEditModalProps> = (props) => {
  const t = useT();
  const fetch = useFetch();
  const idempotency = useIdempotencyKey();
  const ref = useRef(null);
  const existingData = useExistingData();
  const [loading, setLoading] = useState(false);
  const toaster = useToaster();
  const modal = useModals();
  const [showSettings, setShowSettings] = useState(false);
  const [mobileTab, setMobileTab] = useState<'editor' | 'preview'>('editor');
  const { data: shortlinkPreferenceData } = useShortlinkPreference();

  const { addEditSets, mutate, customClose, dummy } = props;

  const {
    selectedIntegrations,
    hide,
    date,
    setDate,
    repeater,
    setRepeater,
    tags,
    setTags,
    integrations,
    setSelectedIntegrations,
    locked,
    current,
    activateExitButton,
    setHide,
  } = useLaunchStore(
    useShallow((state) => ({
      hide: state.hide,
      setHide: state.setHide,
      date: state.date,
      setDate: state.setDate,
      current: state.current,
      repeater: state.repeater,
      setRepeater: state.setRepeater,
      tags: state.tags,
      setTags: state.setTags,
      selectedIntegrations: state.selectedIntegrations,
      integrations: state.integrations,
      setSelectedIntegrations: state.setSelectedIntegrations,
      locked: state.locked,
      activateExitButton: state.activateExitButton,
    }))
  );

  useEffect(() => {
    if (hide) {
      setHide(false);
    }
  }, [hide]);

  // What scheduling to the chosen channels costs, from the server; a draft or a set is not charged.
  const costButton = usePublishCostButton(
    {
      group: existingData.group,
      integrationIds: selectedIntegrations.map((p) => p.integration.id),
      applies: !dummy && !addEditSets,
    },
    t
  );
  const costBlocked = costButton.blocked;

  const currentIntegrationText = useMemo(() => {
    if (current === 'global') {
      return (
        <div className="flex items-center gap-[10px]">
          <div className="relative">
            <SettingsIcon size={15} className="text-white" />
          </div>
          <div>Settings</div>
        </div>
      );
    }

    const currentIntegration = integrations.find((p) => p.id === current)!;

    return (
      <div className="flex items-center gap-[10px]">
        <div className="relative">
          <img
            src={`/icons/platforms/${currentIntegration.identifier}.png`}
            className="w-[20px] h-[20px] rounded-[4px]"
            alt={currentIntegration.identifier}
          />
          <SettingsIcon
            size={15}
            className="text-white absolute -end-[5px] -bottom-[5px]"
          />
        </div>
        <div>
          {currentIntegration.name} {t('channel_settings', 'Settings')}
        </div>
      </div>
    );
  }, [current]);

  // Filters and updates selected integrations matching the newly chosen customer organization.
  const changeCustomer = useCallback(
    (customer: string) => {
      const neededIntegrations = integrations.filter(
        (p) => p?.customer?.id === customer
      );
      setSelectedIntegrations(
        neededIntegrations.map((p) => ({
          settings: {},
          selectedIntegrations: p,
        }))
      );
    },
    [integrations]
  );

  // Confirms with the user before discarding unsaved post edits and closing the modal.
  const askClose = useCallback(async () => {
    if (!activateExitButton || dummy) {
      return;
    }

    if (
      await deleteDialog(
        t(
          'are_you_sure_you_want_to_close_this_modal_all_data_will_be_lost',
          'Are you sure you want to close this modal? (all data will be lost)'
        ),
        t('yes_close_it', 'Yes, close it!')
      )
    ) {
      if (customClose) {
        customClose();
        return;
      }
      modal.closeAll();
    }
  }, [activateExitButton, dummy]);

  // Prompts for confirmation and deletes the currently edited post group via the backend API.
  const deletePost = useCallback(async () => {
    setLoading(true);
    if (
      !(await deleteDialog(
        t(
          'are_you_sure_you_want_to_delete_post',
          'Are you sure you want to delete this post?'
        ),
        t('yes_delete_it', 'Yes, delete it!')
      ))
    ) {
      setLoading(false);
      return;
    }
    await fetch(`/posts/${existingData.group}`, {
      method: 'DELETE',
    });
    mutate();
    modal.closeAll();
    return;
  }, [existingData, mutate, modal]);

  // Validates content, formats payload, checks link preferences, and submits or schedules the post.
  const schedule = useCallback(
    (type: 'draft' | 'now' | 'schedule' | 'update') => async () => {
      let republish = false;
      if (
        (type === 'now' || type === 'schedule') &&
        (existingData?.posts?.[0]?.state === 'PUBLISHED' ||
          (existingData?.posts?.[0]?.state === 'QUEUE' &&
            dayjs().isAfter(date.utc())))
      ) {
        const channels = selectedIntegrations
          .map((p) => p.integration.name)
          .join(', ');
        const isRecurring =
          !!repeater || !!existingData?.posts?.[0]?.intervalInDays;

        const whatToDo = await new Promise((resolve) => {
          modal.openModal({
            title: t('what_do_you_want_to_do', 'What do you want to do?'),
            children: (
              <div className="flex flex-col">
                <div className="text-[20px] mb-[20px]">
                  {t(
                    'post_already_published_republish_warning',
                    'This post was already published. Republishing will publish it again to'
                  )}{' '}
                  {channels} {t('republish_at', 'at')}{' '}
                  {date.format('DD/MM/YYYY HH:mm')}.
                  {isRecurring && (
                    <div className="mt-[10px]">
                      {t(
                        'republish_recurring_note',
                        'This is a recurring post: your changes apply to all future recurrences starting now.'
                      )}
                    </div>
                  )}
                </div>
                <div className="flex w-full gap-[10px]">
                  <div className="flex-1 flex">
                    <Button
                      type="button"
                      className="flex-1"
                      onClick={() => resolve('update')}
                    >
                      {t(
                        'just_update_post_details',
                        'Just update the post details'
                      )}
                    </Button>
                  </div>
                  <div className="flex-1 flex">
                    <Button
                      type="button"
                      className="flex-1"
                      onClick={() => resolve('republish')}
                    >
                      {t('republish_the_post', 'Republish the post')}
                    </Button>
                  </div>
                </div>
              </div>
            ),
          });
        });

        if (whatToDo === 'update') {
          type = 'update';
        }

        if (whatToDo === 'republish') {
          republish = true;
        }
      }

      setLoading(true);

      // Pull the local values to build the payload, but rely on the server
      // (`/posts/valid`) for the actual validation — checkValidity now lives
      // server-side so it can't be bypassed.
      const allValues = await ref.current.getAllValues();

      // Looks up a selected integration configuration by its unique identifier.
      const integrationById = (id: string) =>
        selectedIntegrations.find((p) => p.integration.id === id);

      const group = existingData.group || makeId(10);

      const posts = allValues.map((post: any) => ({
        integration: {
          id: post.id,
        },
        group,
        settings: { ...(post.settings || {}) },
        value: post.values.map((value: any) => ({
          ...(value.id ? { id: value.id } : {}),
          content: value.content,
          delay: value.delay || 0,
          image:
            (value?.media || []).map(
              ({ id, path, alt, thumbnail, thumbnailTimestamp }: any) => ({
                id,
                path,
                alt,
                thumbnail,
                thumbnailTimestamp,
              })
            ) || [],
        })),
      }));

      if (!dummy) {
        const checkAllValid = await (
          await fetch('/posts/valid', {
            method: 'POST',
            body: JSON.stringify({ type, posts }),
          })
        ).json();

        // Triggers focus on a specific integration editor or preview instance when validation fails.
        const focus = (id: string, where: 'fix' | 'preview') => {
          integrationById(id)?.ref?.current?.[where]?.();
        };

        const notEnoughChars = checkAllValid.filter((p: any) => p.emptyContent);

        for (const item of notEnoughChars) {
          toaster.show(
            `${capitalize(item.identifier.split('-')[0])} (${item.name}):` +
              ' ' +
              t(
                'post_needs_content_or_image',
                'Your post should have at least one character or one image.'
              ),
            'warning'
          );
          setLoading(false);
          focus(item.id, 'preview');
          setMobileTab('editor');
          return;
        }

        if (type !== 'draft') {
          for (const item of checkAllValid) {
            if (item.valid === false) {
              toaster.show(
                `${capitalize(item.identifier.split('-')[0])} (${item.name}): ${
                  item.settingsError ||
                  t('please_fix_your_settings', 'Please fix your settings')
                }`,
                'warning'
              );
              focus(item.id, 'fix');
              setLoading(false);
              setShowSettings(true);
              setMobileTab('editor');
              return;
            }

            if (item.errors !== true) {
              toaster.show(
                `${capitalize(item.identifier.split('-')[0])} (${item.name}): ${
                  item.errors
                }`,
                'warning'
              );
              focus(item.id, 'preview');
              setLoading(false);
              setShowSettings(false);
              setMobileTab('preview');
              return;
            }

            if (item.tooLong) {
              toaster.show(
                `${item.name} (${item.identifier}) ${t(
                  'post_is_too_long',
                  'post is too long, please fix it'
                )}`,
                'warning'
              );
              focus(item.id, 'preview');
              setLoading(false);
              setMobileTab('editor');
              return;
            }
          }
        }
      }

      const shortlinkPreference = shortlinkPreferenceData?.shortlink || 'ASK';

      let shortLink = false;

      if (!dummy && shortlinkPreference !== 'NO') {
        const shortLinkUrl = await (
          await fetch('/posts/should-shortlink', {
            method: 'POST',
            body: JSON.stringify({
              messages: allValues
                // platforms that remove links won't keep shortlinks either
                .filter(
                  (p: any) => !integrationById(p.id)?.integration?.stripLinks
                )
                .flatMap((p: any) => p.values.flatMap((a: any) => a.content)),
            }),
          })
        ).json();

        if (shortLinkUrl.ask) {
          if (shortlinkPreference === 'YES') {
            // Automatically shortlink without asking
            shortLink = true;
          } else {
            // ASK: Show the dialog
            shortLink = await deleteDialog(
              t(
                'shortlink_urls_question',
                'Do you want to shortlink the URLs? it will let you get statistics over clicks'
              ),
              t('yes_shortlink_it', 'Yes, shortlink it!'),
              undefined,
              t('no_original_urls', 'No, original URLs')
            );
          }
        }
      }

      const data = {
        type,
        ...(republish ? { republish } : {}),
        ...(repeater ? { inter: repeater } : {}),
        tags,
        shortLink,
        date: date.utc().format('YYYY-MM-DDTHH:mm:ss'),
        posts,
      };

      if (dummy) {
        modal.openModal({
          title: '',
          children: <DummyCodeComponent code={data} />,
          classNames: {
            modal: 'w-[100%] bg-transparent text-textColor',
          },
          size: '100%',
          withCloseButton: false,
          closeOnEscape: true,
          closeOnClickOutside: true,
        });

        setLoading(false);
      }

      if (!dummy) {
        if (addEditSets) {
          addEditSets(data);
        } else {
          const body = JSON.stringify(data);
          const saved = await fetch('/posts', {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotency.key(body) },
            body,
          });
          if (saved.status < 500) {
            idempotency.reset();
          }
        }

        if (!addEditSets) {
          mutate();
          toaster.show(
            !existingData.integration
              ? t('added_successfully', 'Added successfully')
              : t('updated_successfully', 'Updated successfully')
          );
        }
        if (customClose) {
          setTimeout(() => {
            customClose();
          }, 2000);
        }

        if (!addEditSets) {
          modal.closeAll();
        }
      }
    },
    [
      ref,
      repeater,
      tags,
      date,
      addEditSets,
      dummy,
      shortlinkPreferenceData,
      idempotency,
    ]
  );

  return (
    <div
      className={clsx(
        'w-full h-full flex-1 flex relative',
        props.padding || 'p-[12px] sm:p-[20px] lg:p-[40px]'
      )}
    >
      <div className="flex flex-1 bg-newBgColorInner rounded-[20px] flex-col min-h-0 overflow-hidden">
        {/* Mobile top bar with title, close button, and Editor / Preview segmented tab toggle */}
        <div className="flex lg:hidden flex-col bg-newBgColor rounded-t-[20px] border-b border-newBorder shrink-0">
          <div className="h-[56px] flex items-center justify-between px-[16px]">
            <div className="flex items-center gap-[10px] text-[18px] font-[600]">
              {t('create_post_title', 'Create Post')}
              <CreationMethodBadge
                creationMethod={existingData?.posts?.[0]?.creationMethod}
                size="sm"
              />
            </div>
            <div
              className="cursor-pointer p-[8px] -me-[8px] text-[#A3A3A3] hover:text-white"
              onClick={askClose}
              aria-label={t('close', 'Close')}
            >
              <CloseIcon />
            </div>
          </div>
          <div className="px-[16px] pb-[12px]">
            <div className="grid grid-cols-2 p-[3px] bg-newBgColorInner rounded-[10px] border border-newBorder text-[14px] font-[600]">
              <button
                type="button"
                onClick={() => setMobileTab('editor')}
                className={clsx(
                  'py-[8px] rounded-[7px] text-center transition-all min-h-[38px] flex items-center justify-center',
                  mobileTab === 'editor'
                    ? 'bg-btnPrimary text-white shadow-sm'
                    : 'text-textColor hover:text-white'
                )}
              >
                {t('editor', 'Editor')}
              </button>
              <button
                type="button"
                onClick={() => setMobileTab('preview')}
                className={clsx(
                  'py-[8px] rounded-[7px] text-center transition-all min-h-[38px] flex items-center justify-center',
                  mobileTab === 'preview'
                    ? 'bg-btnPrimary text-white shadow-sm'
                    : 'text-textColor hover:text-white'
                )}
              >
                {t('preview', 'Preview')}
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Editor Column */}
          <div
            className={clsx(
              'flex flex-col flex-1 border-e-0 lg:border-e border-newBorder min-h-0',
              mobileTab !== 'editor' && 'hidden lg:flex'
            )}
          >
            <div className="hidden lg:flex bg-newBgColor h-[65px] rounded-s-[20px] !rounded-b-[0] items-center gap-[12px] px-[20px] text-[20px] font-[600]">
              {t('create_post_title', 'Create Post')}
              <CreationMethodBadge
                creationMethod={existingData?.posts?.[0]?.creationMethod}
                size="sm"
              />
            </div>
            <div className="flex-1 flex flex-col gap-[16px] min-h-0">
              <div
                className={clsx('flex-1 relative min-h-0', showSettings && 'hidden')}
              >
                <div
                  id="social-content"
                  className="gap-[20px] sm:gap-[32px] flex flex-col pe-[8px] pt-[16px] sm:pt-[20px] ps-[12px] sm:ps-[20px] absolute top-0 left-0 w-full h-full overflow-x-hidden overflow-y-scroll scrollbar scrollbar-thumb-newColColor scrollbar-track-newBgColorInner"
                >
                  <div className="flex w-full flex-wrap sm:flex-nowrap gap-[8px] sm:gap-[12px] items-center justify-between">
                    <div className="flex flex-1 min-w-[200px]">
                      <PicksSocialsComponent toolTip={true} />
                    </div>
                    <div>
                      {!dummy && (
                        <SelectCustomer
                          onChange={changeCustomer}
                          integrations={integrations}
                        />
                      )}
                    </div>
                  </div>
                  <div className="flex flex-1 gap-[6px] flex-col">
                    <div>{!existingData.integration && <SelectCurrent />}</div>
                    <div className="flex-1 flex">
                      {!hide && <EditorWrapper totalPosts={1} value="" />}
                    </div>
                    <div
                      id="social-empty"
                      className={clsx(
                        'pb-[16px]'
                        // current !== 'global' && 'hidden'
                      )}
                    />
                  </div>
                </div>
              </div>
              <div
                id="wrapper-settings"
                className={clsx(
                  'pb-[20px] px-[12px] sm:px-[20px] select-none',
                  showSettings && 'flex-1 flex pt-[12px] sm:pt-[20px] min-h-0',
                  current === 'global' && 'hidden'
                )}
              >
                <div className="flex-1 flex flex-col rounded-[12px] gap-[12px] overflow-hidden bg-newSettings">
                  <div
                    onClick={() => setShowSettings(!showSettings)}
                    className={clsx(
                      'bg-btnPrimary rounded-[12px] flex items-center gap-[8px] cursor-pointer p-[12px]',
                      showSettings ? '!rounded-b-none' : ''
                    )}
                  >
                    <div className="flex-1 text-[14px] font-[600] text-white">
                      {currentIntegrationText}
                    </div>
                    <div>
                      <ChevronDownIcon
                        rotated={showSettings}
                        className="text-white"
                      />
                    </div>
                  </div>
                  <div
                    className={clsx(
                      !showSettings ? 'hidden' : 'flex-1',
                      'text-[14px] text-textColor font-[500] relative'
                    )}
                  >
                    <div className="absolute left-0 top-0 w-full h-full flex flex-col overflow-x-hidden overflow-y-auto scrollbar scrollbar-thumb-newBgColorInner scrollbar-track-newColColor">
                      <div
                        id="social-settings"
                        className="flex flex-col gap-[20px] bg-newBgColor"
                      />
                    </div>
                  </div>
                  <style>
                    {`#social-settings [data-id="${current}"] {display: block !important;}`}
                  </style>
                </div>
              </div>
            </div>
          </div>

          {/* Preview Column */}
          <div
            className={clsx(
              'w-full lg:w-[580px] flex-col min-h-0',
              mobileTab === 'preview' ? 'flex' : 'hidden lg:flex'
            )}
          >
            <div className="hidden lg:flex bg-newBgColor h-[65px] rounded-e-[20px] !rounded-b-[0] items-center px-[20px] text-[20px] font-[600]">
              <div className="flex-1">{t('post_preview', 'Post Preview')}</div>
              <div className="cursor-pointer">
                <CloseIcon onClick={askClose} className="text-[#A3A3A3]" />
              </div>
            </div>
            <div className="flex-1 relative min-h-0">
              <Scrollable
                scrollClasses="!pe-[20px]"
                className="absolute top-0 p-[12px] sm:p-[20px] pe-[8px] left-0 w-full h-full overflow-x-hidden overflow-y-scroll scrollbar scrollbar-thumb-newColColor scrollbar-track-newBgColorInner"
              >
                <ShowAllProviders ref={ref} />
              </Scrollable>
            </div>
          </div>
        </div>

        {/* Bottom Action Bar */}
        <div className="select-none flex-wrap gap-[8px] h-auto py-[12px] px-[12px] sm:px-[16px] lg:px-0 lg:py-0 lg:h-[84px] border-t border-newBorder flex flex-col lg:flex-row lg:items-center shrink-0">
          <div className="w-full lg:w-auto lg:flex-1 flex flex-wrap items-center justify-between sm:justify-start gap-[8px] ps-0 lg:ps-[20px]">
            <div className="flex flex-wrap items-center gap-[8px]">
              {!dummy && (
                <TagsComponent
                  name="tags"
                  label={t('tags', 'Tags')}
                  initial={tags}
                  onChange={(e) => {
                    setTags(e.target.value);
                  }}
                />
              )}

              {!dummy && (
                <RepeatComponent repeat={repeater} onChange={setRepeater} />
              )}
            </div>
            {existingData?.integration && (
              <button
                onClick={deletePost}
                className="lg:hidden cursor-pointer flex text-[#FF3F3F] gap-[8px] items-center text-[15px] font-[600] py-[8px]"
              >
                <div>
                  <TrashIcon />
                </div>
                <div>{t('delete_post', 'Delete Post')}</div>
              </button>
            )}
          </div>
          <div className="w-full lg:w-auto flex flex-wrap sm:flex-nowrap items-center justify-end gap-[8px] pe-0 lg:pe-[20px]">
            {existingData?.integration && (
              <button
                onClick={deletePost}
                className="hidden lg:flex cursor-pointer text-[#FF3F3F] gap-[8px] items-center text-[15px] font-[600]"
              >
                <div>
                  <TrashIcon />
                </div>
                <div>{t('delete_post', 'Delete Post')}</div>
              </button>
            )}
            <div className="w-full sm:w-auto flex-1 sm:flex-initial">
              <DatePicker onChange={setDate} date={date} />
            </div>
            <div className="w-full sm:w-auto flex items-center gap-[8px] flex-1 sm:flex-initial">
              {!addEditSets && (
                <button
                  disabled={
                    selectedIntegrations.length === 0 || loading || locked
                  }
                  onClick={schedule('draft')}
                  className="flex-1 sm:flex-initial relative cursor-pointer disabled:cursor-not-allowed px-[20px] h-[44px] min-h-[44px] bg-btnSimple justify-center items-center flex rounded-[8px] text-[15px] font-[600]"
                >
                  {loading && (
                    <div className="absolute left-[50%] top-[50%] -translate-y-[50%] -translate-x-[50%]">
                      <div className="animate-spin h-[20px] w-[20px] border-4 border-textColor border-t-transparent rounded-full" />
                    </div>
                  )}
                  <div className={clsx(loading && 'invisible')}>
                    {t('save_as_draft', 'Save as Draft')}
                  </div>
                </button>
              )}
              {addEditSets && (
                <button
                  className="flex-1 sm:flex-initial text-white text-[15px] font-[600] min-w-[140px] sm:min-w-[180px] btnSub disabled:cursor-not-allowed disabled:opacity-80 outline-none gap-[8px] flex justify-center items-center h-[44px] min-h-[44px] rounded-[8px] bg-btnPrimary ps-[20px] pe-[16px]"
                  disabled={
                    selectedIntegrations.length === 0 || loading || locked
                  }
                  onClick={schedule('draft')}
                >
                  Save Set
                </button>
              )}
              {!addEditSets && (
                <div className="group cursor-pointer relative flex-1 sm:flex-initial">
                  <button
                    disabled={
                      selectedIntegrations.length === 0 ||
                      loading ||
                      locked ||
                      costBlocked
                    }
                    onClick={schedule('schedule')}
                    className="w-full text-white relative min-w-[140px] sm:min-w-[180px] btnSub disabled:cursor-not-allowed disabled:opacity-80 outline-none gap-[8px] flex justify-center items-center h-[44px] min-h-[44px] rounded-[8px] bg-btnPrimary ps-[16px] sm:ps-[20px] pe-[12px] sm:pe-[16px]"
                  >
                    {loading && (
                      <div className="absolute left-[50%] top-[50%] -translate-y-[50%] -translate-x-[50%]">
                        <div className="animate-spin h-[20px] w-[20px] border-4 border-white border-t-transparent rounded-full" />
                      </div>
                    )}
                    <div
                      className={clsx(
                        'text-[15px] font-[600] truncate',
                        loading && 'invisible'
                      )}
                    >
                      {selectedIntegrations.length === 0
                        ? t('check_circles_above', 'Check the circles above')
                        : costButton.text
                        ? costButton.text
                        : dummy
                        ? t('create_output', 'Create output')
                        : !existingData?.integration
                        ? t('add_to_calendar', 'Add to calendar')
                        : existingData?.posts?.[0]?.state === 'DRAFT'
                        ? t('schedule', 'Schedule')
                        : t('update', 'Update')}
                    </div>
                    {!dummy && (
                      <div className="flex justify-center items-center h-[20px] w-[20px] pt-[4px] arrow-change shrink-0">
                        <DropdownArrowSmallIcon className="group-hover:rotate-180 text-white" />
                      </div>
                    )}
                  </button>

                  {!dummy && (
                    <button
                      onClick={schedule('now')}
                      disabled={
                        selectedIntegrations.length === 0 ||
                        loading ||
                        locked ||
                        costBlocked
                      }
                      className="rounded-[8px] z-[300] disabled:cursor-not-allowed disabled:opacity-80 hidden group-hover:flex absolute bottom-[100%] -left-[12px] p-[12px] w-[206px] bg-newBgColorInner"
                    >
                      <div className="text-white rounded-[8px] bg-[#D82D7E] h-[44px] w-full flex justify-center items-center post-now">
                        {t('post_now', 'Post Now')}
                      </div>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <CopilotPopup
        Input={AssistantInput}
        hitEscapeToClose={false}
        clickOutsideToClose={true}
        instructions={`
You are an assistant that help the user to schedule their social media posts,
Here are the things you can do:
- Add a new comment / post to the list of posts
- Delete a comment / post from the list of posts
- Add content to the comment / post
- Activate or deactivate the comment / post

Post content can be added using the addPostContentFor{num} function.
After using the addPostFor{num} it will create a new addPostContentFor{num+ 1} function.
`}
        labels={{
          title: t('your_assistant', 'Your Assistant'),
          initial: t(
            'assistant_initial_message',
            'Hi! I can help you to refine your social media posts.'
          ),
        }}
      />
    </div>
  );
};

// Scrollable container wrapper that detects overflow and applies custom scrollbar padding classes.
const Scrollable: FC<{
  className: string;
  scrollClasses: string;
  children: ReactNode;
}> = ({ className, scrollClasses, children }) => {
  const ref = useRef(undefined);
  const hasScroll = useHasScroll(ref);
  return (
    <div className={clsx(className, hasScroll && scrollClasses)} ref={ref}>
      {children}
    </div>
  );
};
