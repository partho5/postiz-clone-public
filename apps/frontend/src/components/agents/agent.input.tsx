// Feature: AI Agents Copilot Chat - Message Input & Submission Bar
import React, { useMemo, useRef, useState } from 'react';
import {
  useCopilotChatInternal,
  useCopilotContext,
  useCopilotReadable,
} from '@copilotkit/react-core';
import AutoResizingTextarea from '@gitroom/frontend/components/agents/agent.textarea';
import { useChatContext, InputProps } from '@copilotkit/react-ui';
import { AiCostLine } from '@gitroom/frontend/components/credits/cost/ai.cost.line';
import { useAiCost } from '@gitroom/frontend/components/credits/cost/use.ai.cost';
const MAX_NEWLINES = 6;

// Renders the agent chat input box with auto-resizing textarea, attachments, and credit cost.
export const Input = ({
  inProgress,
  onSend,
  isVisible = false,
  onStop,
  onUpload,
  hideStopButton = false,
  onChange,
}: InputProps & { onChange?: (value: string) => void }) => {
  const context = useChatContext();
  const copilotContext = useCopilotContext();
  const showPoweredBy = !copilotContext.copilotApiConfig?.publicApiKey;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isComposing, setIsComposing] = useState(false);

  const handleDivClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;

    // If the user clicked a button or inside a button, don't focus the textarea
    if (target.closest('button')) return;

    // If the user clicked the textarea, do nothing (it's already focused)
    if (target.tagName === 'TEXTAREA') return;

    // Otherwise, focus the textarea
    textareaRef.current?.focus();
  };

  const [text, setText] = useState('');
  // One message to the assistant costs one text request; sending waits until the server has stated it.
  const cost = useAiCost({ kind: 'text' });
  const send = () => {
    if (inProgress) return;
    onSend(text);
    setText('');

    textareaRef.current?.focus();
  };

  const isInProgress = inProgress;
  const buttonIcon =
    isInProgress && !hideStopButton
      ? context.icons.stopIcon
      : context.icons.sendIcon;

  const { interrupt } = useCopilotChatInternal();
  const canSend = useMemo(() => {
    return (
      !isInProgress && text.trim().length > 0 && !interrupt && !!cost.data
    );
  }, [interrupt, isInProgress, text, cost.data]);

  const canStop = useMemo(() => {
    return isInProgress && !hideStopButton;
  }, [isInProgress, hideStopButton]);

  const sendDisabled = !canSend && !canStop;

  return (
    <div
      className={`copilotKitInputContainer ${
        showPoweredBy ? 'poweredByContainer' : ''
      } w-full min-w-0 max-w-full`}
    >
      <div
        className="copilotKitInput w-full min-w-0 max-w-full"
        onClick={handleDivClick}
      >
        <AutoResizingTextarea
          ref={textareaRef}
          placeholder={context.labels.placeholder}
          autoFocus={false}
          maxRows={MAX_NEWLINES}
          value={text}
          onChange={(event) => {
            onChange?.(event.target.value);
            setText(event.target.value);
          }}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !isComposing) {
              event.preventDefault();
              if (canSend) {
                send();
              }
            }
          }}
        />
        <div className="copilotKitInputControls flex items-center flex-wrap sm:flex-nowrap gap-[6px] min-h-[44px]">
          {onUpload && (
            <button
              onClick={onUpload}
              className="copilotKitInputControlButton min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
              aria-label="Upload attachment"
            >
              {context.icons.uploadIcon}
            </button>
          )}

          <div style={{ flexGrow: 1 }} />
          <AiCostLine estimate={cost.data} error={cost.error} />
          <button
            disabled={sendDisabled}
            onClick={isInProgress && !hideStopButton ? onStop : send}
            data-copilotkit-in-progress={inProgress}
            data-test-id={
              inProgress
                ? 'copilot-chat-request-in-progress'
                : 'copilot-chat-ready'
            }
            className="copilotKitInputControlButton min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
            aria-label="Send message"
          >
            {buttonIcon}
          </button>
        </div>
      </div>
    </div>
  );
};
