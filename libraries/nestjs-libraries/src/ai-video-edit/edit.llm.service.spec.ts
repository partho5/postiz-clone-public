// ai.video-editing: the decision service sends each call to the provider of its option, with the option's model and
// effort, and the providers are the only ones it knows.
import { EditLlmService } from './edit.llm.service';
import { resolveEditLlm } from './edit.llm';

describe('ai.video-editing: EditLlmService routing', () => {
  const openai = { writeEditTexts: jest.fn(), pickEditIcons: jest.fn(), directEdit: jest.fn() };
  const anthropic = { writeEditTexts: jest.fn(), pickEditIcons: jest.fn(), directEdit: jest.fn() };
  const muse = { writeEditTexts: jest.fn(), pickEditIcons: jest.fn(), directEdit: jest.fn() };
  const service = new EditLlmService(
    openai as any,
    anthropic as any,
    muse as any
  );
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

  it('sends a Muse option to the Muse client with its model and effort', async () => {
    const usage: any[] = [];
    await service.writeEditTexts(
      resolveEditLlm('muse-spark-1.3-contributor'),
      MESSAGES,
      usage
    );
    await service.pickEditIcons(
      resolveEditLlm('muse-spark-1.3-contributor'),
      MESSAGES
    );

    expect(muse.writeEditTexts).toHaveBeenCalledWith(
      'muse-spark-1.3-contributor',
      'high',
      MESSAGES,
      usage
    );
    expect(muse.pickEditIcons).toHaveBeenCalledWith(
      'muse-spark-1.3-contributor',
      'high',
      MESSAGES,
      undefined
    );
    expect(anthropic.writeEditTexts).not.toHaveBeenCalled();
    expect(openai.writeEditTexts).not.toHaveBeenCalled();
  });

  it('sends the director call to the provider of its option, with the option model and effort', async () => {
    const usage: any[] = [];
    await service.directEdit(resolveEditLlm('claude-sonnet-5-5'), MESSAGES, usage);
    await service.directEdit(resolveEditLlm('gpt-5-nano'), MESSAGES);
    await service.directEdit(resolveEditLlm('muse-spark-1.3-contributor'), MESSAGES);

    expect(anthropic.directEdit).toHaveBeenCalledWith('claude-sonnet-5-5', 'medium', MESSAGES, usage);
    expect(openai.directEdit).toHaveBeenCalledWith('gpt-5-nano', 'low', MESSAGES, undefined);
    expect(muse.directEdit).toHaveBeenCalledWith('muse-spark-1.3-contributor', 'high', MESSAGES, undefined);
    expect(anthropic.directEdit).toHaveBeenCalledTimes(1);
    expect(openai.directEdit).toHaveBeenCalledTimes(1);
    expect(muse.directEdit).toHaveBeenCalledTimes(1);
  });
});
