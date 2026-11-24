import { Input } from '@gitroom/react/form/input';
import { FC, useCallback, useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { Select } from '@gitroom/react/form/select';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { setCookie } from '@gitroom/frontend/components/layout/layout.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { Button } from '@gitroom/react/form/button';
import { ImportDebugPostModal } from '@gitroom/frontend/components/launches/import-debug-post.modal';
import { useForm, FormProvider } from 'react-hook-form';
import { classValidatorResolver } from '@hookform/resolvers/class-validator';
import { AdminAddTeamMemberDto } from '@gitroom/nestjs-libraries/dtos/settings/admin.add.team.member.dto';

const colorOptions = [
  { value: 'INFO', label: 'Info (Blue)', className: 'bg-blue-600' },
  { value: 'WARNING', label: 'Warning (Amber)', className: 'bg-amber-600' },
  { value: 'ERROR', label: 'Error (Red)', className: 'bg-red-600' },
];

const AddAnnouncementModal: FC<{ close: () => void }> = ({ close }) => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  const t = useT();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('INFO');
  const [saving, setSaving] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || !description.trim()) return;
    setSaving(true);
    try {
      await fetch('/announcements', {
        method: 'POST',
        body: JSON.stringify({ title, description, color }),
      });
      await mutate('/announcements');
      close();
    } finally {
      setSaving(false);
    }
  }, [title, description, color]);

  return (
    <div className="flex flex-col gap-[16px] min-w-[500px]">
      <Input
        label={t('announcement_title', 'Title')}
        name="title"
        disableForm={true}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t('announcement_title_placeholder', 'Announcement title')}
      />
      <div className="flex flex-col gap-[6px]">
        <label className="text-[14px]">
          {t('announcement_description', 'Description')}
        </label>
        <textarea
          className="bg-input border border-tableBorder rounded-[8px] p-[10px] text-newTextColor min-h-[120px] outline-none resize-y"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t(
            'announcement_description_placeholder',
            'Announcement description'
          )}
        />
      </div>
      <div className="flex flex-col gap-[6px]">
        <label className="text-[14px]">
          {t('announcement_color', 'Color')}
        </label>
        <div className="flex gap-[8px]">
          {colorOptions.map((opt) => (
            <div
              key={opt.value}
              onClick={() => setColor(opt.value)}
              className={`flex-1 text-center py-[8px] rounded-[8px] text-white text-[13px] cursor-pointer transition-opacity ${opt.className} ${
                color === opt.value ? 'opacity-100 ring-2 ring-white' : 'opacity-40'
              }`}
            >
              {opt.label}
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          onClick={handleSubmit}
          loading={saving}
          disabled={!title.trim() || !description.trim()}
          className="rounded-[4px]"
        >
          {t('create_announcement', 'Create Announcement')}
        </Button>
      </div>
    </div>
  );
};

export const AddAnnouncement = () => {
  const { openModal } = useModals();
  const t = useT();

  const handleClick = useCallback(() => {
    openModal({
      title: t('add_announcement', 'Add Announcement'),
      children: (close) => <AddAnnouncementModal close={close} />,
    });
  }, []);

  return (
    <div
      className="px-[10px] rounded-[4px] bg-green-700 text-white cursor-pointer whitespace-nowrap"
      onClick={handleClick}
    >
      {t('add_announcement', 'Add Announcement')}
    </div>
  );
};

const AddTeamMemberModal: FC<{ close: () => void }> = ({ close }) => {
  const fetch = useFetch();
  const toast = useToaster();
  const t = useT();
  const [saving, setSaving] = useState(false);
  const resolver = useMemo(() => {
    return classValidatorResolver(AdminAddTeamMemberDto);
  }, []);
  const form = useForm({
    values: {
      email: '',
      role: '',
    },
    resolver,
    mode: 'onChange',
  });

  const submit = useCallback(
    async (values: { email: string; role: string }) => {
      setSaving(true);
      try {
        const response = await fetch('/settings/team/add', {
          method: 'POST',
          body: JSON.stringify(values),
        });
        if (!response.ok) {
          toast.show(
            (await response.json()).message ||
              t('could_not_add_member', 'Could not add the member'),
            'warning'
          );
          return;
        }
        toast.show(t('member_added', 'Member added'));
        close();
      } finally {
        setSaving(false);
      }
    },
    []
  );

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(submit)}>
        <div className="flex flex-col gap-[10px] min-w-[400px]">
          <Input
            label="Email"
            placeholder={t('enter_email', 'Enter email')}
            name="email"
          />
          <Select label="Role" name="role">
            <option value="">{t('select_role', 'Select Role')}</option>
            <option value="USER">{t('user', 'User')}</option>
            <option value="ADMIN">{t('admin', 'Admin')}</option>
          </Select>
          <Button type="submit" loading={saving} className="rounded-[4px]">
            {t('add_team_member', 'Add Team Member')}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
};

const AddTeamMember = () => {
  const { openModal } = useModals();
  const t = useT();

  const handleClick = useCallback(() => {
    openModal({
      title: t('add_team_member', 'Add Team Member'),
      children: (close) => <AddTeamMemberModal close={close} />,
    });
  }, []);

  return (
    <div
      className="px-[10px] rounded-[4px] bg-teal-700 text-white cursor-pointer whitespace-nowrap"
      onClick={handleClick}
    >
      {t('add_team_member', 'Add Team Member')}
    </div>
  );
};

export const ImportDebugPost = () => {
  const { openModal } = useModals();
  const t = useT();

  const handleClick = useCallback(() => {
    openModal({
      title: t('import_debug_post', 'Import Debug Post'),
      maxSize: 800,
      children: (close) => <ImportDebugPostModal close={close} />,
    });
  }, []);

  return (
    <div
      className="px-[10px] rounded-[4px] bg-yellow-600 text-white cursor-pointer whitespace-nowrap"
      onClick={handleClick}
    >
      {t('import_debug_post', 'Import Debug Post')}
    </div>
  );
};

const SwitchUser = () => {
  const fetch = useFetch();
  const t = useT();
  const toaster = useToaster();
  const currentUser = useUser();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<{
    id: string;
    name: string;
    email: string;
  } | null>(null);
  const [switching, setSwitching] = useState(false);

  const load = useCallback(async () => {
    if (!name) {
      return [];
    }
    return await (await fetch(`/user/impersonate?name=${name}`)).json();
  }, [name]);

  const { data } = useSWR(`/switch-search-${name}`, load, {
    refreshWhenHidden: false,
    revalidateOnMount: true,
    revalidateOnReconnect: false,
    revalidateOnFocus: false,
    refreshWhenOffline: false,
    revalidateIfStale: false,
    refreshInterval: 0,
  });

  const mapData = useMemo(() => {
    // one row per user-organization: dedupe by user id, drop the impersonated user
    const seen = new Set<string>();
    return (data || [])
      .filter((curr: any) => curr?.user?.id !== currentUser?.id)
      .filter((curr: any) => {
        if (seen.has(curr?.user?.id)) {
          return false;
        }
        seen.add(curr?.user?.id);
        return true;
      })
      .map((curr: any) => ({
        id: curr?.user?.id,
        name: curr?.user?.name,
        email: curr?.user?.email,
        orgs: (data || [])
          .filter((org: any) => org?.user?.id === curr?.user?.id)
          .map(
            (org: any) =>
              `${org?.organization?.name} (${org?.role} / ${
                org?.organization?.subscription?.subscriptionTier || 'FREE'
              })`
          )
          .join(', '),
      }));
  }, [data, currentUser?.id]);

  const pick = useCallback(
    (item: { id: string; name: string; email: string }) => () => {
      setSelected(item);
      setName('');
    },
    []
  );

  const doSwitch = useCallback(async () => {
    if (!selected) {
      return;
    }
    if (
      !(await deleteDialog(
        t(
          'switch_user_confirm',
          `This will replace the current account's login with ${selected.email}. All data and the subscription stay with the account — only the login changes, and the new login gains its full access. Switch back to revert.`
        ),
        t('yes_switch', 'Yes, switch'),
        t('switch_user_title', 'Switch User?'),
        t('no_cancel', 'No, cancel')
      ))
    ) {
      return;
    }
    setSwitching(true);
    try {
      const res = await fetch('/user/switch', {
        method: 'POST',
        body: JSON.stringify({ id: selected.id }),
      });
      // customFetch does not throw on HTTP errors
      if (!res.ok) {
        throw new Error(await res.text().catch(() => ''));
      }
      window.location.reload();
    } catch {
      setSwitching(false);
      toaster.show(
        t('switch_user_failed', 'The user switch failed and nothing was changed'),
        'warning'
      );
    }
  }, [selected]);

  return (
    <div className="relative flex items-center gap-[10px]">
      <div className="flex-1 min-w-[220px]">
        <Input
          autoComplete="off"
          placeholder={t('select_user_to_switch_to', 'Select user to switch to')}
          name="switchUser"
          disableForm={true}
          label=""
          removeError={true}
          value={
            selected
              ? `${selected.name ? `${selected.name} - ` : ''}${selected.email}`
              : name
          }
          onChange={(e) => {
            setSelected(null);
            setName(e.target.value);
          }}
        />
      </div>
      <Button
        onClick={doSwitch}
        loading={switching}
        disabled={!selected}
        className="rounded-[4px] whitespace-nowrap"
      >
        {t('switch_user', 'Switch User')}
      </Button>
      {!!mapData?.length && !selected && (
        <>
          <div
            className="bg-primary/80 fixed start-0 top-0 w-full h-full z-[998]"
            onClick={() => setName('')}
          />
          <div className="absolute top-[100%] start-0 w-max min-w-full max-w-[90vw] bg-sixth border border-customColor6 text-textColor z-[999]">
            {mapData.map((item: any) => (
              <div
                onClick={pick(item)}
                key={item?.id}
                className="p-[10px] border-b border-customColor6 hover:bg-tableBorder cursor-pointer whitespace-nowrap truncate"
              >
                {t('user_1', 'user:')}
                {item?.id?.split('-')?.at(-1)} -{' '}
                {item?.name ? `${item?.name} - ` : ''}
                {item?.email}
                {item?.orgs ? ` - ${item?.orgs}` : ''}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// The strip shown on every page, only while a super admin impersonates, so the admin can always stop or switch.
export const ImpersonateStrip = () => {
  const fetch = useFetch();
  const { isSecured } = useVariables();
  const user = useUser();
  const t = useT();
  const stopImpersonating = useCallback(async () => {
    if (!isSecured) {
      setCookie('impersonate', '', -10);
    } else {
      await fetch(`/user/impersonate`, {
        method: 'POST',
        body: JSON.stringify({
          id: '',
        }),
      });
    }
    window.location.reload();
  }, []);

  return (
    <div className="bg-forth h-[52px] flex justify-center items-center border-input border rounded-[8px] text-white w-full px-[20px]">
      <div className="text-center flex justify-center items-center gap-[10px]">
        <div className="whitespace-nowrap">
          {t('currently_impersonating', 'Currently Impersonating')}
        </div>
        <div>
          <div
            className="px-[10px] rounded-[4px] bg-red-500 text-white cursor-pointer"
            onClick={stopImpersonating}
          >
            X
          </div>
        </div>
        {user?.tier?.team_members && <AddTeamMember />}
        <SwitchUser />
      </div>
    </div>
  );
};

// The super admin page's user search: picking a user starts impersonating them.
export const ImpersonateUsers = () => {
  const fetch = useFetch();
  const [name, setName] = useState('');
  const t = useT();
  const load = useCallback(async () => {
    if (!name) {
      return [];
    }
    const value = await (await fetch(`/user/impersonate?name=${name}`)).json();
    return value;
  }, [name]);

  const setUser = useCallback(
    (userId: string) => async () => {
      await fetch(`/user/impersonate`, {
        method: 'POST',
        body: JSON.stringify({
          id: userId,
        }),
      });
      window.location.reload();
    },
    []
  );
  const { data } = useSWR(`/impersonate-${name}`, load, {
    refreshWhenHidden: false,
    revalidateOnMount: true,
    revalidateOnReconnect: false,
    revalidateOnFocus: false,
    refreshWhenOffline: false,
    revalidateIfStale: false,
    refreshInterval: 0,
  });
  const mapData = useMemo(() => {
    return data?.map(
      (curr: any) => ({
        id: curr?.id,
        name: curr?.user?.name,
        email: curr?.user?.email,
        orgName: curr?.organization?.name,
        role: curr?.role,
        tier: curr?.organization?.subscription?.subscriptionTier || 'FREE',
      }),
      []
    );
  }, [data]);
  return (
    <div className="relative flex flex-col max-w-[600px]">
      <div className="relative z-[1]">
        <Input
          autoComplete="off"
          placeholder={t('write_the_user_details', 'Write the user details')}
          name="impersonate"
          disableForm={true}
          label={t('impersonate_user', 'Impersonate a user')}
          removeError={true}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {!!data?.length && (
        <>
          <div
            className="bg-primary/80 fixed start-0 top-0 w-full h-full z-[998]"
            onClick={() => setName('')}
          />
          <div className="absolute top-[100%] w-max min-w-full max-w-[90vw] start-0 bg-sixth border border-customColor6 text-textColor z-[999]">
            {mapData?.map((user: any) => (
              <div
                onClick={setUser(user?.id)}
                key={user?.id}
                className="p-[10px] border-b border-customColor6 hover:bg-tableBorder cursor-pointer whitespace-nowrap truncate"
              >
                {t('user_1', 'user:')}
                {user?.id?.split('-')?.at(-1)} - {user?.name} - {user?.email}{' '}
                - {user?.orgName} ({user?.role} / {user?.tier})
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
