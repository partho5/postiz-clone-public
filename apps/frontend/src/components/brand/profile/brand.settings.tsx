// Feature: Brand Settings and Identity Profile
'use client';

// Brand profile: the Settings "Brand" tab, showing the workspace's brand and letting its
// admins change the typed fields, the avatar and the validated creative profile.
import { FC, useCallback, useEffect, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { Textarea } from '@gitroom/react/form/textarea';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { showMediaBox } from '@gitroom/frontend/components/media/media.component';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useIdempotencyKey } from '@gitroom/frontend/components/layout/use.idempotency.key';
import { useCurrentBrand } from '@gitroom/frontend/components/brand/profile/use.current.brand';
import { BrandView } from '@gitroom/nestjs-libraries/dtos/brands/brand.profile.schema';

// A brand as the form holds it: the list fields are comma-separated text.
interface BrandDraft {
  name: string;
  color: string;
  avatarUrl: string;
  timezone: string;
  locale: string;
  tagline: string;
  audience: string;
  voice: string;
  pillars: string;
  bannedWords: string;
}

// The comma-separated entries of a text, trimmed and without empty ones.
const splitList = (text: string) =>
  text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

// The form values of a brand read from the server.
const draftOf = (brand: BrandView): BrandDraft => ({
  name: brand.name,
  color: brand.color,
  avatarUrl: brand.avatarUrl ?? '',
  timezone: brand.timezone,
  locale: brand.locale,
  tagline: brand.profile.tagline ?? '',
  audience: (brand.profile.audience ?? []).join(', '),
  voice: brand.profile.voice ?? '',
  pillars: (brand.profile.pillars ?? []).join(', '),
  bannedWords: (brand.profile.bannedWords ?? []).join(', '),
});

// The body of `PUT /brands/current` for the form values; an empty profile field is left out.
const payloadOf = (draft: BrandDraft) => {
  const audience = splitList(draft.audience);
  const pillars = splitList(draft.pillars);
  const bannedWords = splitList(draft.bannedWords);
  return {
    name: draft.name.trim(),
    color: draft.color,
    ...(draft.avatarUrl ? { avatarUrl: draft.avatarUrl } : {}),
    timezone: draft.timezone.trim(),
    locale: draft.locale.trim(),
    profile: {
      schemaVersion: 1 as const,
      ...(draft.tagline.trim() ? { tagline: draft.tagline.trim() } : {}),
      ...(audience.length ? { audience } : {}),
      ...(draft.voice.trim() ? { voice: draft.voice.trim() } : {}),
      ...(pillars.length ? { pillars } : {}),
      ...(bannedWords.length ? { bannedWords } : {}),
    },
  };
};

// The failing paths of an INVALID_BRAND answer, each with its message.
const fieldErrors = (body: unknown): Record<string, string> => {
  const fields = (body as { fields?: { path: string; message: string }[] })
    ?.fields;
  return Object.fromEntries(
    (Array.isArray(fields) ? fields : []).map((field) => [
      field.path,
      field.message,
    ])
  );
};

// The Brand tab: the brand's fields, editable for admins and read-only for other members.
export const BrandSettings: FC = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const t = useT();
  const user = useUser();
  const idempotency = useIdempotencyKey();
  const { data: brand, error, mutate } = useCurrentBrand();
  const [draft, setDraft] = useState<BrandDraft | undefined>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const canEdit = user?.role === 'ADMIN' || user?.role === 'SUPERADMIN';

  useEffect(() => {
    if (brand) {
      setDraft(draftOf(brand));
    }
  }, [brand]);

  // Sets one field of the form.
  const set = useCallback(
    (field: keyof BrandDraft) => (value: string) =>
      setDraft((held) => (held ? { ...held, [field]: value } : held)),
    []
  );

  // Opens the media library and takes the chosen picture as the avatar.
  const chooseAvatar = useCallback(() => {
    showMediaBox(({ path }) => set('avatarUrl')(path));
  }, [set]);

  // Saves the form; an INVALID_BRAND answer puts each message under its field and stores nothing.
  const save = useCallback(async () => {
    if (!draft) {
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const body = payloadOf(draft);
      const response = await fetch('/brands/current', {
        method: 'PUT',
        headers: { 'Idempotency-Key': idempotency.key(JSON.stringify(body)) },
        body: JSON.stringify(body),
      });
      if (response.status < 500) {
        idempotency.reset();
      }
      if (response.status === 400) {
        setErrors(fieldErrors(await response.json()));
        toaster.show(
          t('brand_invalid', 'Some brand fields are not valid'),
          'warning'
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
      await mutate(await response.json(), { revalidate: false });
      toaster.show(t('brand_saved', 'Brand saved'), 'success');
    } catch {
      toaster.show(
        t('failed_to_save_brand', 'Failed to save the brand'),
        'warning'
      );
    } finally {
      setBusy(false);
    }
  }, [draft, fetch, idempotency, mutate, t, toaster]);

  if (error && !brand) {
    return (
      <div className="text-red-400">
        {t('failed_to_load_brand', 'Failed to load the brand')}
      </div>
    );
  }

  if (!draft) {
    return null;
  }

  return (
    <div className="flex flex-col gap-[20px]">
      <div className="flex flex-col">
        <h3 className="text-[20px]">{t('brand', 'Brand')}</h3>
        <div className="text-textItemBlur mt-[4px]">
          {canEdit
            ? t(
                'brand_settings_description',
                'How this brand looks and sounds. Only admins can change it.'
              )
            : t(
                'brand_settings_read_only',
                'How this brand looks and sounds. Ask an admin to change it.'
              )}
        </div>
      </div>

      <div className="bg-sixth border-fifth border rounded-[4px] p-[16px] sm:p-[24px] flex flex-col gap-[8px]">
        <div className="flex flex-col sm:flex-row sm:items-center gap-[16px]">
          <div
            className="w-[56px] h-[56px] rounded-full bg-cover bg-center shrink-0"
            style={{
              backgroundColor: draft.color,
              backgroundImage: draft.avatarUrl
                ? `url("${draft.avatarUrl}")`
                : undefined,
            }}
          />
          {canEdit && (
            <Button secondary={true} onClick={chooseAvatar} className="min-h-[44px] w-full sm:w-auto">
              {t('choose_avatar', 'Choose avatar')}
            </Button>
          )}
        </div>
        {!!errors.avatarUrl && (
          <div className="text-red-400 text-[12px]">{errors.avatarUrl}</div>
        )}

        <Input
          label={t('brand_name', 'Name')}
          name="brandName"
          disableForm={true}
          disabled={!canEdit}
          value={draft.name}
          error={errors.name}
          onChange={(e) => set('name')(e.target.value)}
        />
        <div className="flex flex-col gap-[6px]">
          <div className="text-[14px]">{t('brand_color', 'Color')}</div>
          <div className="flex items-center gap-[12px]">
            <input
              type="color"
              aria-label={t('brand_color', 'Color')}
              disabled={!canEdit}
              value={draft.color}
              onChange={(e) => set('color')(e.target.value)}
              className="h-[42px] w-[80px] bg-transparent cursor-pointer rounded-[4px]"
            />
            <span className="text-[13px] text-textItemBlur font-mono">{draft.color}</span>
          </div>
          <div className="text-red-400 text-[12px]">
            {errors.color || <>&nbsp;</>}
          </div>
        </div>
        <Input
          label={t('brand_timezone', 'Time zone')}
          name="brandTimezone"
          disableForm={true}
          disabled={!canEdit}
          value={draft.timezone}
          error={errors.timezone}
          onChange={(e) => set('timezone')(e.target.value)}
        />
        <Input
          label={t('brand_locale', 'Language')}
          name="brandLocale"
          disableForm={true}
          disabled={!canEdit}
          value={draft.locale}
          error={errors.locale}
          onChange={(e) => set('locale')(e.target.value)}
        />
        <Input
          label={t('brand_tagline', 'Tagline')}
          name="brandTagline"
          disableForm={true}
          disabled={!canEdit}
          value={draft.tagline}
          error={errors['profile.tagline']}
          onChange={(e) => set('tagline')(e.target.value)}
        />
        <Input
          label={t('brand_audience', 'Audience (comma-separated)')}
          name="brandAudience"
          disableForm={true}
          disabled={!canEdit}
          value={draft.audience}
          error={errors['profile.audience']}
          onChange={(e) => set('audience')(e.target.value)}
        />
        <Textarea
          label={t('brand_voice', 'Voice')}
          name="brandVoice"
          disableForm={true}
          disabled={!canEdit}
          value={draft.voice}
          error={errors['profile.voice']}
          onChange={(e) => set('voice')(e.target.value)}
        />
        <Input
          label={t('brand_pillars', 'Content pillars (comma-separated)')}
          name="brandPillars"
          disableForm={true}
          disabled={!canEdit}
          value={draft.pillars}
          error={errors['profile.pillars']}
          onChange={(e) => set('pillars')(e.target.value)}
        />
        <Input
          label={t('brand_banned_words', 'Banned words (comma-separated)')}
          name="brandBannedWords"
          disableForm={true}
          disabled={!canEdit}
          value={draft.bannedWords}
          error={errors['profile.bannedWords']}
          onChange={(e) => set('bannedWords')(e.target.value)}
        />
      </div>

      {canEdit && (
        <div className="flex flex-col sm:flex-row">
          <Button onClick={save} loading={busy} className="min-h-[44px] w-full sm:w-auto">
            {t('save', 'Save')}
          </Button>
        </div>
      )}
    </div>
  );
};
