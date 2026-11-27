// Feature: Prompt Book Admin Defaults and Locked Frames Editor
'use client';

// Prompt Book (ai.video-captions): /super-admin/prompts, where the owner edits the default of every prompt,
// the locked frames and the model each prompt runs on, and restores an earlier version. A change
// reaches the next caption job of every workspace that never edited that prompt; nothing is deployed.
import React, { FC, useCallback, useEffect, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { Button } from '@gitroom/react/form/button';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import {
  PROMPT_DEFAULT_MAX_LENGTH,
  PROMPT_FRAME_PLACEHOLDERS,
  PROMPT_REASONING_EFFORTS,
} from '@gitroom/nestjs-libraries/dtos/prompt-book/save.prompt.dto';
import {
  AdminPrompt,
  AdminPromptVersion,
  useAdminPromptHistory,
  useAdminPrompts,
} from '@gitroom/frontend/components/admin/use.admin.prompts';

const SECTIONS: { group: AdminPrompt['group']; title: string; hint: string }[] =
  [
    {
      group: 'frame',
      title: 'Locked frames',
      hint: `Only you edit these. A frame wraps a workspace's instructions with the transcript, the limits, the language rule and the output format, so a workspace edit cannot break the output. Keep every placeholder: ${PROMPT_FRAME_PLACEHOLDERS.map(
        (name) => `{{${name}}}`
      ).join(' ')}`,
    },
    {
      group: 'general',
      title: 'Brand voice',
      hint: 'The default voice every platform shares. A workspace edits its own copy in Settings, AI prompts.',
    },
    {
      group: 'video',
      title: 'Video captions',
      hint: 'The instructions per platform for a post that carries the video. "All other platforms" is used by a platform without its own entry.',
    },
    {
      group: 'text',
      title: 'Text posts',
      hint: 'The instructions per platform for a post that has no video.',
    },
  ];

// One stored version of a default: its details, its text on click, and bringing it back.
const VersionRow: FC<{
  version: AdminPromptVersion;
  current: boolean;
  onRestore: (version: number) => void;
}> = ({ version, current, onRestore }) => {
  const [shown, setShown] = useState(false);
  return (
    <div className="border-b border-newTableBorder last:border-b-0 px-[12px] py-[8px] text-[13px] w-full min-w-0">
      <div className="flex flex-wrap sm:flex-nowrap items-center gap-[8px] sm:gap-[12px] justify-between">
        <div
          className="flex-1 min-w-0 cursor-pointer"
          onClick={() => setShown((value) => !value)}
        >
          <span className="font-[600]">v{version.version}</span>{' '}
          <span className="opacity-70 break-words text-[12px]">
            {new Date(version.createdAt).toLocaleString()} · {version.model} ·{' '}
            {version.reasoningEffort}
            {version.note ? ` · ${version.note}` : ''}
          </span>
        </div>
        <div className="shrink-0">
          {current ? (
            <div className="text-[12px] text-green-500 font-[600] py-[4px] px-[8px]">
              Current
            </div>
          ) : (
            <Button
              className="min-h-[38px] sm:min-h-0"
              secondary
              onClick={() => onRestore(version.version)}
            >
              Restore
            </Button>
          )}
        </div>
      </div>
      {shown && (
        <pre className="mt-[8px] text-[12px] bg-sixth p-[12px] rounded overflow-auto max-h-[40vh] whitespace-pre-wrap break-words">
          {version.body}
        </pre>
      )}
    </div>
  );
};

// One prompt opened: its text, model and reasoning effort to save as a new version, and its history.
const PromptEditor: FC<{ prompt: AdminPrompt; onChanged: () => void }> = ({
  prompt,
  onChanged,
}) => {
  const fetch = useFetch();
  const toaster = useToaster();
  const {
    data: history,
    error: historyError,
    mutate: reloadHistory,
  } = useAdminPromptHistory(prompt.key);
  const [body, setBody] = useState(prompt.body);
  const [model, setModel] = useState(prompt.model);
  const [reasoningEffort, setReasoningEffort] = useState(
    prompt.reasoningEffort
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Follows the version the server holds after a save or a restore.
  useEffect(() => {
    setBody(prompt.body);
    setModel(prompt.model);
    setReasoningEffort(prompt.reasoningEffort);
    setNote('');
  }, [prompt.version]);

  // Shows why the server refused, or the fallback line.
  const refused = useCallback(
    async (response: Response, fallback: string) => {
      const answer = await response.json().catch(() => ({}));
      toaster.show(
        typeof answer?.message === 'string' ? answer.message : fallback,
        'warning'
      );
    },
    [toaster]
  );

  const save = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch('/admin/prompts', {
        method: 'PUT',
        body: JSON.stringify({
          key: prompt.key,
          body,
          model,
          reasoningEffort,
          note: note.trim() || undefined,
        }),
      });
      if (!response.ok) {
        await refused(response, 'Failed to save the prompt');
        return;
      }
      toaster.show('Saved as a new version', 'success');
      onChanged();
      reloadHistory();
    } catch {
      toaster.show('Failed to save the prompt', 'warning');
    } finally {
      setBusy(false);
    }
  }, [
    body,
    fetch,
    model,
    note,
    onChanged,
    prompt.key,
    reasoningEffort,
    refused,
    reloadHistory,
    toaster,
  ]);

  const restore = useCallback(
    async (version: number) => {
      try {
        const response = await fetch(
          `/admin/prompts/${encodeURIComponent(prompt.key)}/restore`,
          { method: 'POST', body: JSON.stringify({ version }) }
        );
        if (!response.ok) {
          await refused(response, 'Failed to restore the version');
          return;
        }
        toaster.show(`Version ${version} restored as a new version`, 'success');
        onChanged();
        reloadHistory();
      } catch {
        toaster.show('Failed to restore the version', 'warning');
      }
    },
    [fetch, onChanged, prompt.key, refused, reloadHistory, toaster]
  );

  const unchanged =
    body.trim() === prompt.body &&
    model.trim() === prompt.model &&
    reasoningEffort === prompt.reasoningEffort;

  return (
    <div className="flex flex-col gap-[12px] pt-[12px] w-full min-w-0">
      <textarea
        className="w-full bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[12px] text-[13px] text-textColor outline-none min-h-[220px] resize-y font-mono min-w-0"
        value={body}
        maxLength={PROMPT_DEFAULT_MAX_LENGTH}
        disabled={busy}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex flex-wrap gap-[12px] items-stretch sm:items-end w-full min-w-0">
        <div className="flex flex-col gap-[6px] w-full sm:w-auto">
          <div className="text-[12px] opacity-70">Model</div>
          <input
            value={model}
            maxLength={100}
            disabled={busy}
            onChange={(event) => setModel(event.target.value)}
            className="bg-newBgColorInner h-[38px] border border-newTableBorder rounded-[8px] px-[10px] text-[14px] text-textColor w-full sm:min-w-[200px]"
          />
        </div>
        <div className="flex flex-col gap-[6px] w-full sm:w-auto">
          <div className="text-[12px] opacity-70">Reasoning effort</div>
          <select
            value={reasoningEffort}
            disabled={busy}
            onChange={(event) => setReasoningEffort(event.target.value)}
            className="bg-newBgColorInner h-[38px] border border-newTableBorder rounded-[8px] px-[10px] text-[14px] text-textColor w-full sm:w-auto"
          >
            {PROMPT_REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-[6px] w-full sm:flex-1 sm:min-w-[200px]">
          <div className="text-[12px] opacity-70">Note (optional)</div>
          <input
            value={note}
            maxLength={500}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What changed"
            className="bg-newBgColorInner h-[38px] border border-newTableBorder rounded-[8px] px-[10px] text-[14px] text-textColor w-full"
          />
        </div>
        <div className="w-full sm:w-auto flex items-end">
          <Button
            className="min-h-[44px] w-full sm:w-auto whitespace-nowrap"
            loading={busy}
            disabled={!body.trim() || !model.trim() || unchanged}
            onClick={save}
          >
            Save as new version
          </Button>
        </div>
      </div>
      <div className="text-[13px] font-[600]">History</div>
      {historyError ? (
        <div className="text-red-400">Failed to load the history.</div>
      ) : history === undefined ? (
        <LoadingComponent />
      ) : (
        <div className="border border-newTableBorder rounded-[8px] overflow-hidden overflow-x-auto w-full scrollbar-thin">
          <div className="min-w-0 w-full">
            {history.map((version) => (
              <VersionRow
                key={version.version}
                version={version}
                current={version.version === prompt.version}
                onRestore={restore}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// The page: the prompts by section, each collapsed until opened.
export const AdminPromptsComponent: FC = () => {
  const user = useUser();
  const { data: prompts, error, mutate } = useAdminPrompts();
  const [open, setOpen] = useState('');
  const changed = useCallback(() => {
    mutate();
  }, [mutate]);

  if (!user?.isSuperAdmin) {
    return (
      <div className="text-textColor p-[20px]">
        You do not have access to this page.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[16px] text-textColor w-full min-w-0">
      <div className="flex flex-wrap gap-[8px] items-center justify-between">
        <div className="text-[20px] font-[600]">Prompt Book</div>
      </div>
      {error ? (
        <div className="text-red-400">Failed to load the prompts.</div>
      ) : prompts === undefined ? (
        <LoadingComponent />
      ) : (
        SECTIONS.map((section) => (
          <div key={section.group} className="flex flex-col gap-[8px] w-full min-w-0">
            <div className="text-[16px] font-[600]">{section.title}</div>
            <div className="text-[13px] opacity-70 break-words">{section.hint}</div>
            <div className="border border-newTableBorder rounded-[8px] overflow-hidden w-full min-w-0">
              {prompts
                .filter((prompt) => prompt.group === section.group)
                .map((prompt) => (
                  <div
                    key={prompt.key}
                    className="border-b border-newTableBorder last:border-b-0 px-[12px] py-[10px]"
                  >
                    <div
                      className="flex flex-wrap sm:flex-nowrap items-center gap-[8px] sm:gap-[12px] cursor-pointer min-h-[44px]"
                      onClick={() =>
                        setOpen((current) =>
                          current === prompt.key ? '' : prompt.key
                        )
                      }
                    >
                      <div className="flex items-center gap-[8px] sm:gap-[12px] flex-1 min-w-0">
                        {prompt.provider ? (
                          <img
                            className="w-[24px] h-[24px] rounded-full shrink-0"
                            src={`/icons/platforms/${prompt.provider}.png`}
                            alt={prompt.label}
                          />
                        ) : (
                          <div className="w-[24px] h-[24px] shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-[14px] font-[600] truncate">
                            {prompt.label}
                          </div>
                          <div className="text-[12px] opacity-60 font-mono truncate">
                            {prompt.key}
                          </div>
                        </div>
                      </div>
                      <div className="text-[12px] opacity-70 shrink-0 self-center">
                        v{prompt.version} · {prompt.model}
                      </div>
                    </div>
                    {open === prompt.key && (
                      <PromptEditor prompt={prompt} onChanged={changed} />
                    )}
                  </div>
                ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
};
