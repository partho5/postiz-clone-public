// ai.video-editing: which model a decision runs on. The options, the default, the environment chain of the writer and
// the icon picker, and the key each option needs. The environment is set per test and restored after.
import {
  EDIT_DECISION_MODEL,
  editLlmConfigured,
  iconEditLlm,
  resolveEditLlm,
  writerEditLlm,
} from './edit.llm';

const KEYS = [
  'AI_EDIT_WRITER_MODEL',
  'AI_EDIT_ICON_MODEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;
const saved: Record<string, string | undefined> = {};

describe('ai.video-editing: the decision models', () => {
  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults the decisions to Claude Haiku 5.5 at high effort', () => {
    expect(EDIT_DECISION_MODEL).toBe('claude-haiku-5-5');
    expect(writerEditLlm()).toEqual({
      model: 'claude-haiku-5-5',
      provider: 'anthropic',
      effort: 'high',
    });
    expect(iconEditLlm()).toEqual({
      model: 'claude-haiku-5-5',
      provider: 'anthropic',
      effort: 'high',
    });
  });

  it('keeps gpt-5-nano as an option at its low effort', () => {
    expect(resolveEditLlm('gpt-5-nano')).toEqual({
      model: 'gpt-5-nano',
      provider: 'openai',
      effort: 'low',
    });
    process.env.AI_EDIT_WRITER_MODEL = 'gpt-5-nano';
    expect(writerEditLlm()).toEqual({
      model: 'gpt-5-nano',
      provider: 'openai',
      effort: 'low',
    });
  });

  it('runs an unlisted model on the provider its name belongs to, at that provider default effort', () => {
    expect(resolveEditLlm('gpt-4.1')).toEqual({
      model: 'gpt-4.1',
      provider: 'openai',
      effort: 'low',
    });
    expect(resolveEditLlm('claude-sonnet-5-5')).toEqual({
      model: 'claude-sonnet-5-5',
      provider: 'anthropic',
      effort: 'high',
    });
  });

  it('takes the icon picker from AI_EDIT_ICON_MODEL, then AI_EDIT_WRITER_MODEL, then the default', () => {
    process.env.AI_EDIT_WRITER_MODEL = 'gpt-5-nano';
    expect(iconEditLlm().model).toBe('gpt-5-nano');

    process.env.AI_EDIT_ICON_MODEL = 'claude-haiku-5-5';
    expect(iconEditLlm().model).toBe('claude-haiku-5-5');
  });

  it('needs the key of the option provider', () => {
    const haiku = resolveEditLlm('claude-haiku-5-5');
    const nano = resolveEditLlm('gpt-5-nano');
    expect(editLlmConfigured(haiku)).toBe(false);
    expect(editLlmConfigured(nano)).toBe(false);

    process.env.ANTHROPIC_API_KEY = 'set';
    expect(editLlmConfigured(haiku)).toBe(true);
    expect(editLlmConfigured(nano)).toBe(false);
  });
});
