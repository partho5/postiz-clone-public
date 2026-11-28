import { Injectable } from '@nestjs/common';
import { AnthropicService } from '@gitroom/nestjs-libraries/anthropic/anthropic.service';
import { MuseChatService } from '@gitroom/nestjs-libraries/muse/muse.chat.service';
import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';
import {
  EditDirection,
  EditIconPicks,
  EditLlmClient,
  EditLlmMessage,
  EditLlmOption,
  EditLlmProvider,
  EditTextsDraft,
  editLlmConfigured,
} from '@gitroom/nestjs-libraries/ai-video-edit/edit.llm';
import { LlmUsage } from '@gitroom/nestjs-libraries/ai-video-edit/llm.usage';

// The decision calls of AI video editing (ai.video-editing): sends each one to the provider of its option. The
// providers are registered here by name and nowhere else.
@Injectable()
export class EditLlmService {
  private _clients: Record<EditLlmProvider, EditLlmClient>;

  constructor(
    private _openai: OpenaiService,
    private _anthropic: AnthropicService,
    private _muse: MuseChatService
  ) {
    this._clients = {
      openai: this._openai,
      anthropic: this._anthropic,
      meta: this._muse,
    };
  }

  // Whether the option can run: its provider's key is set.
  isConfigured(option: EditLlmOption) {
    return editLlmConfigured(option);
  }

  // The writer's call: the texts of the slots, or null when the model refused or answered nothing usable.
  writeEditTexts(
    option: EditLlmOption,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditTextsDraft | null> {
    return this._clients[option.provider].writeEditTexts(
      option.model,
      option.effort,
      messages,
      usage
    );
  }

  // The icon picker's call: the picks of the slots, or null when the model refused or answered nothing usable.
  pickEditIcons(
    option: EditLlmOption,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditIconPicks | null> {
    return this._clients[option.provider].pickEditIcons(
      option.model,
      option.effort,
      messages,
      usage
    );
  }

  // The director's call: the style and the sentence labels, or null when the model refused or answered nothing usable.
  directEdit(
    option: EditLlmOption,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditDirection | null> {
    return this._clients[option.provider].directEdit(
      option.model,
      option.effort,
      messages,
      usage
    );
  }
}
