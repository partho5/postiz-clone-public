// ai.video-editing: the decision service sends each call to the provider of its option, with the option's model and
// effort, and the providers are the only ones it knows.
import { EditLlmService } from './edit.llm.service';
import { resolveEditLlm } from './edit.llm';

describe('ai.video-editing: EditLlmService routing', () => {
  const openai = { writeEditTexts: jest.fn(), pickEditIcons: jest.fn() };
  const anthropic = { writeEditTexts: jest.fn(), pickEditIcons: jest.fn() };
  const service = new EditLlmService(openai as any, anthropic as any);
  const MESSAGES = [{ role: 'user' as const, content: 'x' }];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends a Claude option to Anthropic with its model and effort', async () => {
    const usage: any[] = [];
    await service.writeEditTexts(
      resolveEditLlm('claude-haiku-5-5'),
      MESSAGES,
      usage
    );

    expect(anthropic.writeEditTexts).toHaveBeenCalledWith(
      'claude-haiku-5-5',
      'high',
      MESSAGES,
      usage
    );
    expect(openai.writeEditTexts).not.toHaveBeenCalled();
  });

  it('sends a GPT option to OpenAI with its model and effort', async () => {
    await service.pickEditIcons(resolveEditLlm('gpt-5-nano'), MESSAGES);

    expect(openai.pickEditIcons).toHaveBeenCalledWith(
      'gpt-5-nano',
      'low',
      MESSAGES,
      undefined
    );
    expect(anthropic.pickEditIcons).not.toHaveBeenCalled();
  });
});
