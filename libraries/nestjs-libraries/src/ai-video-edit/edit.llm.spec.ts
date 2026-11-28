// ai.video-editing: which model a decision runs on. The options, the switch, the environment chain of the writer and
// the icon picker, the key each option needs and the system message helper. The environment is set per test and restored
// after.
import {
  EDIT_DECISION_MODEL,
  EDIT_FALLBACK_MODEL,
  EditLlmMessage,
  decisionEditLlm,
  directorEditLlm,
  editLlmConfigured,
  iconEditLlm,
  resolveEditLlm,
  splitSystem,
  writerEditLlm,
} from './edit.llm';

const KEYS = [
  'AI_EDIT_DECISION_MODEL',
  'AI_EDIT_WRITER_MODEL',
  'AI_EDIT_ICON_MODEL',
  'AI_EDIT_DIRECTOR_MODEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'META_MUSE_API_KEY',
] as const;
const saved: Record<string, string | undefined> = {};

const MUSE = {
  model: 'muse-spark-1.3-contributor',
  provider: 'meta',
  effort: 'high',
};
const HAIKU = {
  model: 'claude-haiku-5-5',
  provider: 'anthropic',
  effort: 'high',
};

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

  it('defaults the decisions to Muse Spark at high effort, with Claude Haiku 5.5 as the fallback', () => {
    expect(EDIT_DECISION_MODEL).toBe('muse-spark-1.3-contributor');
    expect(EDIT_FALLBACK_MODEL).toBe('claude-haiku-5-5');
    process.env.META_MUSE_API_KEY = 'set';
    expect(decisionEditLlm()).toEqual(MUSE);
    expect(writerEditLlm()).toEqual(MUSE);
    expect(iconEditLlm()).toEqual(MUSE);
  });

  it('keeps the default (not configured) when neither the Muse key nor the fallback key is set', () => {
    expect(decisionEditLlm()).toEqual(MUSE);
    expect(editLlmConfigured(decisionEditLlm())).toBe(false);
  });

  it('runs on Claude Haiku 5.5 when the Muse key is unset, there is no env var and the Anthropic key is set', () => {
    process.env.ANTHROPIC_API_KEY = 'set';
    expect(decisionEditLlm()).toEqual(HAIKU);
    expect(writerEditLlm()).toEqual(HAIKU);
    expect(iconEditLlm()).toEqual(HAIKU);
  });

  it('prefers Muse over the fallback when both keys are set', () => {
    process.env.META_MUSE_API_KEY = 'set';
    process.env.ANTHROPIC_API_KEY = 'set';
    expect(decisionEditLlm()).toEqual(MUSE);
  });

  it('takes the switch from AI_EDIT_DECISION_MODEL, listed models at their own effort', () => {
    process.env.AI_EDIT_DECISION_MODEL = 'claude-sonnet-5-5';
    expect(decisionEditLlm()).toEqual({
      model: 'claude-sonnet-5-5',
      provider: 'anthropic',
      effort: 'medium',
    });
    expect(writerEditLlm().model).toBe('claude-sonnet-5-5');
    expect(iconEditLlm().model).toBe('claude-sonnet-5-5');
  });

  it('does not fall back from an explicit AI_EDIT_DECISION_MODEL whose key is unset', () => {
    process.env.ANTHROPIC_API_KEY = 'set';
    process.env.AI_EDIT_DECISION_MODEL = 'muse-spark-1.3-contributor';
    const option = decisionEditLlm();
    expect(option).toEqual(MUSE);
    expect(editLlmConfigured(option)).toBe(false);
    expect(writerEditLlm()).toEqual(MUSE);
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
    expect(resolveEditLlm('claude-opus-5-5')).toEqual({
      model: 'claude-opus-5-5',
      provider: 'anthropic',
      effort: 'high',
    });
    expect(resolveEditLlm('muse-x')).toEqual({
      model: 'muse-x',
      provider: 'meta',
      effort: 'high',
    });
  });

  it('lets the role variables win over the switch', () => {
    process.env.AI_EDIT_DECISION_MODEL = 'claude-sonnet-5-5';
    process.env.AI_EDIT_WRITER_MODEL = 'gpt-5-nano';
    expect(writerEditLlm().model).toBe('gpt-5-nano');
    expect(decisionEditLlm().model).toBe('claude-sonnet-5-5');
  });

  it('takes the icon picker from AI_EDIT_ICON_MODEL, then AI_EDIT_WRITER_MODEL, then the switch', () => {
    process.env.AI_EDIT_DECISION_MODEL = 'claude-sonnet-5-5';
    expect(iconEditLlm().model).toBe('claude-sonnet-5-5');

    process.env.AI_EDIT_WRITER_MODEL = 'gpt-5-nano';
    expect(iconEditLlm().model).toBe('gpt-5-nano');

    process.env.AI_EDIT_ICON_MODEL = 'claude-haiku-5-5';
    expect(iconEditLlm().model).toBe('claude-haiku-5-5');
  });

  it('takes the director from AI_EDIT_DIRECTOR_MODEL, else the switch (not the writer or icon variables)', () => {
    process.env.META_MUSE_API_KEY = 'set';
    expect(directorEditLlm()).toEqual(MUSE);

    process.env.AI_EDIT_WRITER_MODEL = 'gpt-5-nano';
    process.env.AI_EDIT_ICON_MODEL = 'gpt-5-nano';
    expect(directorEditLlm()).toEqual(MUSE);

    process.env.AI_EDIT_DECISION_MODEL = 'claude-sonnet-5-5';
    expect(directorEditLlm().model).toBe('claude-sonnet-5-5');

    process.env.AI_EDIT_DIRECTOR_MODEL = 'claude-haiku-5-5';
    expect(directorEditLlm()).toEqual(HAIKU);
    expect(writerEditLlm().model).toBe('gpt-5-nano');
  });

  it('runs the director on the fallback when the Muse key is unset and there is no env var, and does not fall back from an explicit choice', () => {
    process.env.ANTHROPIC_API_KEY = 'set';
    expect(directorEditLlm()).toEqual(HAIKU);

    process.env.AI_EDIT_DIRECTOR_MODEL = 'muse-spark-1.3-contributor';
    const option = directorEditLlm();
    expect(option).toEqual(MUSE);
    expect(editLlmConfigured(option)).toBe(false);
  });

  it('needs the key of the option provider', () => {
    const haiku = resolveEditLlm('claude-haiku-5-5');
    const nano = resolveEditLlm('gpt-5-nano');
    const muse = resolveEditLlm('muse-spark-1.3-contributor');
    expect(editLlmConfigured(haiku)).toBe(false);
    expect(editLlmConfigured(nano)).toBe(false);
    expect(editLlmConfigured(muse)).toBe(false);

    process.env.ANTHROPIC_API_KEY = 'set';
    expect(editLlmConfigured(haiku)).toBe(true);
    expect(editLlmConfigured(nano)).toBe(false);
    expect(editLlmConfigured(muse)).toBe(false);

    process.env.META_MUSE_API_KEY = 'set';
    expect(editLlmConfigured(muse)).toBe(true);

    process.env.META_MUSE_API_KEY = '   ';
    expect(editLlmConfigured(muse)).toBe(false);
  });
});

describe('ai.video-editing: splitSystem', () => {
  it('returns no system and every message when there is no system message', () => {
    const messages: EditLlmMessage[] = [
      { role: 'user', content: 'alpha' },
      { role: 'assistant', content: 'beta' },
    ];
    const split = splitSystem(messages);
    expect(split.system).toBeUndefined();
    expect(split.rest).toEqual(messages);
  });

  it('joins the system messages with a blank line, in order, and keeps the others in order', () => {
    const split = splitSystem([
      { role: 'system', content: 'rule one' },
      { role: 'user', content: 'alpha' },
      { role: 'system', content: 'rule two' },
      { role: 'assistant', content: 'beta' },
    ]);
    expect(split.system).toBe('rule one\n\nrule two');
    expect(split.rest).toEqual([
      { role: 'user', content: 'alpha' },
      { role: 'assistant', content: 'beta' },
    ]);
  });
});
