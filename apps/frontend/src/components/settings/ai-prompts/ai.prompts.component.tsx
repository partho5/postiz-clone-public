'use client';

// Prompt Book (ai.video-captions): the Settings "AI prompts" card. Every prompt starts as the default
// text and a workspace may save its own; "Default" marks a prompt that still reads the default, so
// an improved default reaches it without anything to do.
import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { PROMPT_BODY_MAX_LENGTH } from '@gitroom/nestjs-libraries/dtos/prompt-book/save.prompt.dto';
import {
  PromptBookItem,
  usePromptBook,
} from '@gitroom/frontend/components/settings/ai-prompts/use.prompt.book';

// One platform: the video caption and the text post prompts it has, either may be missing.
interface PlatformRow {
  id: string;
  label: string;
  provider?: string;
  video?: PromptBookItem;
  text?: PromptBookItem;
}

// The platform rows of the list, in the order the book gives them: the shared prompts first.
const platformRows = (items: PromptBookItem[]) => {
  const rows = new Map<string, PlatformRow>();
  for (const item of items) {
    if (item.group === 'general') {
      continue;
    }
    const id = item.provider ?? 'default';
    const row = rows.get(id) ?? {
      id,
      label: item.label,
      provider: item.provider,
    };
    row[item.group] = item;
    rows.set(id, row);
  }
  return Array.from(rows.values());
};

// One prompt: its text, saving it as the workspace's own and going back to the default.
const PromptEditor: FC<{
  item: PromptBookItem;
  title: string;
  onChanged: () => void;
}> = ({ item, title, onChanged }) => {
  const fetch = useFetch();
  const toaster = useToaster();
  const t = useT();
  const [value, setValue] = useState(item.body);
  const [busy, setBusy] = useState(false);

  // Follows the text the server holds after a save, a reset or a new default.
  useEffect(() => {
    setValue(item.body);
  }, [item.body]);

  const url = `/prompt-book/${encodeURIComponent(item.key)}`;

  // Shows why the server refused, or the fallback line.
  const refused = useCallback(
    async (response: Response, fallback: string) => {
      const body = await response.json().catch(() => ({}));
      toaster.show(
        typeof body?.message === 'string' ? body.message : fallback,
        'warning'
      );
    },
    [toaster]
  );

  const save = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch(url, {
        method: 'PUT',
        body: JSON.stringify({ body: value }),
      });
      if (!response.ok) {
        await refused(
          response,
          t('failed_to_save_prompt', 'Failed to save the prompt')
        );
        return;
      }
      toaster.show(t('prompt_saved', 'Prompt saved'), 'success');
      onChanged();
    } catch {
      toaster.show(
        t('failed_to_save_prompt', 'Failed to save the prompt'),
        'warning'
      );
    } finally {
      setBusy(false);
    }
  }, [fetch, onChanged, refused, t, toaster, url, value]);

  const reset = useCallback(async () => {
    if (
      !(await deleteDialog(
        t(
          'are_you_sure_reset_prompt',
          'Go back to the default text? Your own text for this prompt is removed.'
        ),
        t('yes_reset', 'Yes, reset')
      ))
    ) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(url, { method: 'DELETE' });
      if (!response.ok) {
        await refused(
          response,
          t('failed_to_reset_prompt', 'Failed to reset the prompt')
        );
        return;
      }
      toaster.show(t('prompt_reset', 'Back to the default'), 'success');
      onChanged();
    } catch {
      toaster.show(
        t('failed_to_reset_prompt', 'Failed to reset the prompt'),
        'warning'
      );
    } finally {
      setBusy(false);
    }
  }, [fetch, onChanged, refused, t, toaster, url]);

  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex items-center gap-[8px] text-[13px]">
        <span className="font-[600]">{title}</span>
        {item.isDefault && (
          <span className="text-[12px] text-textItemBlur border border-newBorder rounded-[4px] px-[6px]">
            {t('default', 'Default')}
          </span>
        )}
      </div>
      <textarea
        className="bg-newBgColorInner border border-newBorder rounded-[8px] p-[12px] text-[13px] text-textColor outline-none min-h-[110px] resize-y"
        value={value}
        maxLength={PROMPT_BODY_MAX_LENGTH}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="flex items-center gap-[8px]">
        <Button
          loading={busy}
          disabled={!value.trim() || value.trim() === item.body}
          onClick={save}
        >
          {t('save', 'Save')}
        </Button>
        {!item.isDefault && (
          <Button secondary disabled={busy} onClick={reset}>
            {t('reset_to_default', 'Reset to default')}
          </Button>
        )}
        <div className="flex-1 text-end text-[12px] text-textItemBlur">
          {value.length}/{PROMPT_BODY_MAX_LENGTH}
        </div>
      </div>
    </div>
  );
};

// One platform, collapsed until opened: its video caption and text post prompts.
const PlatformPrompts: FC<{
  row: PlatformRow;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}> = ({ row, open, onToggle, onChanged }) => {
  const t = useT();
  const edited = [row.video, row.text].some((item) => item && !item.isDefault);
  return (
    <div className="border border-newBorder rounded-[8px] p-[12px]">
      <div
        className="flex items-center gap-[12px] cursor-pointer"
        onClick={onToggle}
      >
        {row.provider ? (
          <img
            className="w-[28px] h-[28px] rounded-full"
            src={`/icons/platforms/${row.provider}.png`}
            alt={row.label}
          />
        ) : (
          <div className="w-[28px] h-[28px]" />
        )}
        <div className="flex-1 text-[14px] font-[600]">{row.label}</div>
        <div
          className={clsx(
            'text-[12px]',
            edited ? 'text-green-500' : 'text-textItemBlur'
          )}
        >
          {edited
            ? t('prompt_edited', 'Edited')
            : t('prompt_default', 'Default')}
        </div>
      </div>
      {open && (
        <div className="flex flex-col gap-[16px] pt-[12px]">
          {row.video && (
            <PromptEditor
              item={row.video}
              title={t('video_caption', 'Video caption')}
              onChanged={onChanged}
            />
          )}
          {row.text && (
            <PromptEditor
              item={row.text}
              title={t('text_post', 'Text post')}
              onChanged={onChanged}
            />
          )}
        </div>
      )}
    </div>
  );
};

// The card: the brand voice every caption shares, then one row per platform.
export const AiPromptsComponent: FC = () => {
  const t = useT();
  const { data: items, error, mutate } = usePromptBook();
  const [open, setOpen] = useState('');
  const changed = useCallback(() => {
    mutate();
  }, [mutate]);
  const general = items?.find((item) => item.group === 'general');
  const rows = useMemo(() => platformRows(items || []), [items]);

  if (error) {
    return (
      <div className="rounded-[12px] border border-newBorder p-[20px] text-[13px] text-textItemBlur">
        {t('failed_to_load_prompts', 'Failed to load the AI prompts')}
      </div>
    );
  }

  if (items === undefined) {
    return null;
  }

  return (
    <div className="rounded-[12px] border border-newBorder overflow-hidden">
      <div className="px-[20px] py-[14px] border-b border-newBorder">
        <div className="text-[15px] font-[600]">
          {t('ai_prompts', 'AI prompts')}
        </div>
        <div className="text-[13px] text-textItemBlur mt-[2px]">
          {t(
            'ai_prompts_description',
            'The instructions the AI follows when it writes captions from your videos. Each one starts as our default text. Edit a prompt to make it yours, or reset it to get the default back.'
          )}
        </div>
      </div>
      <div className="p-[20px] flex flex-col gap-[12px]">
        {general && (
          <div className="border border-newBorder rounded-[8px] p-[12px]">
            <PromptEditor
              item={general}
              title={t(
                'ai_prompts_brand_voice',
                'Brand voice (every platform)'
              )}
              onChanged={changed}
            />
          </div>
        )}
        {rows.map((row) => (
          <PlatformPrompts
            key={row.id}
            row={row}
            open={open === row.id}
            onToggle={() =>
              setOpen((current) => (current === row.id ? '' : row.id))
            }
            onChanged={changed}
          />
        ))}
      </div>
    </div>
  );
};
