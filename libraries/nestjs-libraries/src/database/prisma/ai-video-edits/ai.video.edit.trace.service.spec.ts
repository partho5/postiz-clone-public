// ai.video-editing (L1): the trace service. Modes, redaction, the size cap, a repository error that never reaches the
// job, `time` rethrowing the error of its function, and the retention cutoff. Runs on a hand-made repository; needs no
// database.
import {
  TraceService,
  redact,
  traceDays,
  traceMaxBytes,
  traceMode,
} from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.service';

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.repository',
  () => ({ AiVideoEditTraceRepository: class {} })
);

const EDIT = 'edit-1';
const ORG = 'org-1';

// The repository as the service uses it: appended rows are kept, and a failure can be switched on.
class FakeRepository {
  rows: any[] = [];
  organizationLookups = 0;
  failAppend: Error | null = null;
  deleted: Date[] = [];
  async organizationOf(editId: string) {
    this.organizationLookups++;
    return editId === EDIT ? ORG : null;
  }
  async append(row: any) {
    if (this.failAppend) {
      throw this.failAppend;
    }
    this.rows.push({ ...row, seq: this.rows.length + 1 });
  }
  list = jest.fn();
  async deleteCreatedBefore(cutoff: Date) {
    this.deleted.push(cutoff);
    return 3;
  }
}

const ENV_KEYS = [
  'AI_EDIT_TRACE',
  'AI_EDIT_TRACE_MAX_BYTES',
  'AI_EDIT_TRACE_DAYS',
  'TEST_PROVIDER_API_KEY',
];

describe('ai.video-editing: trace environment values', () => {
  it('reads the mode: off and full are exact, anything else is meta', () => {
    expect(traceMode(undefined)).toBe('meta');
    expect(traceMode('')).toBe('meta');
    expect(traceMode(' FULL ')).toBe('full');
    expect(traceMode('off')).toBe('off');
    expect(traceMode('ful')).toBe('meta');
  });

  it('reads the size cap and the retention, with the defaults for a bad value', () => {
    expect(traceMaxBytes(undefined)).toBe(524288);
    expect(traceMaxBytes('1000')).toBe(1000);
    expect(traceMaxBytes('0')).toBe(524288);
    expect(traceMaxBytes('12kb')).toBe(524288);
    expect(traceDays(undefined)).toBe(365);
    expect(traceDays('30')).toBe(30);
    expect(traceDays('0')).toBe(365);
    expect(traceDays('40000')).toBe(365);
  });
});

describe('ai.video-editing: trace redaction', () => {
  it('replaces the value of a credential key and keeps counts named like one', () => {
    expect(
      redact(
        {
          Authorization: 'Bearer abcdefghijkl',
          apiKey: 'x',
          'x-api-key': 'y',
          access_token: 'z',
          cookie: 'c',
          prompt_tokens: 120,
          nested: { client_secret: 's', ok: 1 },
        },
        []
      )
    ).toEqual({
      Authorization: '[redacted]',
      apiKey: '[redacted]',
      'x-api-key': '[redacted]',
      access_token: '[redacted]',
      cookie: '[redacted]',
      prompt_tokens: 120,
      nested: { client_secret: '[redacted]', ok: 1 },
    });
  });

  it('removes the query string of a URL and keeps the rest of it', () => {
    expect(
      redact(
        {
          url: 'https://cdn.example.com/a/b.png?X-Amz-Signature=abc&X-Amz-Credential=def',
          text: 'see https://x.test/f.mp4?token=1 and https://y.test/plain',
        },
        []
      )
    ).toEqual({
      url: 'https://cdn.example.com/a/b.png?[redacted]',
      text: 'see https://x.test/f.mp4?[redacted] and https://y.test/plain',
    });
  });

  it('removes auth values and provider keys inside a string', () => {
    const out = redact(
      {
        header: 'sent Bearer abcdefghijklmnop to the model',
        raw: 'key sk-abcdefghijklmnopqrstuvwx and AIzaSyA1234567890123456789012345678901',
      },
      []
    ) as Record<string, string>;
    expect(out.header).toBe('sent Bearer [redacted] to the model');
    expect(out.raw).toBe('key [redacted] and [redacted]');
  });

  it('removes the value of a credential variable of the process wherever it appears', () => {
    process.env.TEST_PROVIDER_API_KEY = 'plain-secret-value';
    try {
      expect(redact({ note: 'called with plain-secret-value ok' })).toEqual({
        note: 'called with [redacted] ok',
      });
    } finally {
      delete process.env.TEST_PROVIDER_API_KEY;
    }
  });

  it('turns what JSON cannot hold into plain JSON', () => {
    const out = redact(
      { when: new Date('2026-11-22T00:00:00Z'), n: NaN, big: BigInt(5), fn: () => 1, none: undefined, err: new Error('boom') },
      []
    );
    expect(out).toEqual({
      when: '2026-11-22T00:00:00.000Z',
      n: null,
      big: '5',
      err: { name: 'Error', message: 'boom' },
    });
  });

  it('stops at a circular structure instead of looping', () => {
    const loop: any = { a: 1 };
    loop.self = loop;
    expect(() => JSON.stringify(redact(loop, []))).not.toThrow();
  });
});

describe('ai.video-editing: TraceService.record', () => {
  let repository: FakeRepository;
  let service: TraceService;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    ENV_KEYS.forEach((key) => {
      saved[key] = process.env[key];
      delete process.env[key];
    });
    repository = new FakeRepository();
    service = new TraceService(repository as any);
    jest.spyOn((service as any)._logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    ENV_KEYS.forEach((key) => {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    });
  });

  const WORDS = { words: [{ text: 'secret', start: 1 }], language: 'en', words_count: 1, note: 'private text', provider: 'openai' };

  it('writes nothing in mode off', async () => {
    process.env.AI_EDIT_TRACE = 'off';
    await service.record(EDIT, { step: 'transcribe', kind: 'output', payload: WORDS });
    expect(repository.rows).toEqual([]);
  });

  it('keeps counts, codes, bytes and the hash in mode meta (the default), never the text', async () => {
    await service.record(EDIT, { step: 'transcribe', kind: 'output', attempt: 2, durationMs: 120.4, ok: true, payload: WORDS });
    expect(repository.rows).toHaveLength(1);
    const row = repository.rows[0];
    expect(row).toMatchObject({ editId: EDIT, organizationId: ORG, step: 'transcribe', kind: 'output', attempt: 2, durationMs: 120, ok: true, seq: 1 });
    expect(row.payload).toEqual({ words: { count: 1 }, language: 'en', words_count: 1, note_chars: 12, provider: 'openai' });
    expect(JSON.stringify(row.payload)).not.toContain('secret');
    expect(JSON.stringify(row.payload)).not.toContain('private');
    expect(row.payloadBytes).toBe(Buffer.byteLength(JSON.stringify(WORDS)));
    expect(row.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the whole redacted JSON in mode full, with the same bytes and hash as meta', async () => {
    await service.record(EDIT, { step: 'transcribe', kind: 'output', payload: WORDS });
    process.env.AI_EDIT_TRACE = 'full';
    await service.record(EDIT, { step: 'transcribe', kind: 'output', payload: { ...WORDS, url: 'https://a.test/x?sig=1' } });
    await service.record(EDIT, { step: 'transcribe', kind: 'output', payload: WORDS });
    const [meta, withUrl, full] = repository.rows;
    expect(full.payload).toEqual(WORDS);
    expect(withUrl.payload.url).toBe('https://a.test/x?[redacted]');
    expect(full.payloadSha256).toBe(meta.payloadSha256);
    expect(full.payloadBytes).toBe(meta.payloadBytes);
  });

  it('keeps the whole usage row in mode meta: the work label (ids and counts), the model, the tokens and the flags', async () => {
    const usage = {
      step: 'write',
      work: 'writer texts for 5 slots',
      model: 'gpt-5.1',
      input_tokens: 1200,
      output_tokens: 300,
      total_tokens: 1500,
      cached_tokens: 100,
      estimated: false,
      latency_ms: 900,
      attempt: 2,
      ok: true,
    };
    await service.record(EDIT, { step: 'usage', kind: 'metric', ok: true, payload: usage });
    await service.record(EDIT, { step: 'usage', kind: 'metric', payload: { ...usage, work: 'x'.repeat(65), network: 'free text' } });

    expect(repository.rows[0].payload).toEqual(usage);
    // a label over 64 characters is only a text then: it is cut to its length; only the `work` key itself is a label
    expect(repository.rows[1].payload).toMatchObject({ work_chars: 65, network_chars: 9 });
    expect(repository.rows[1].payload.work).toBeUndefined();
  });

  it('redacts in every mode', async () => {
    process.env.AI_EDIT_TRACE = 'full';
    await service.record(EDIT, { step: 'perceive', kind: 'input', payload: { headers: { Authorization: 'Bearer abcdefghijkl' } } });
    expect(repository.rows[0].payload).toEqual({ headers: { Authorization: '[redacted]' } });
  });

  it('replaces a payload over the size cap with its size and hash', async () => {
    process.env.AI_EDIT_TRACE = 'full';
    process.env.AI_EDIT_TRACE_MAX_BYTES = '200';
    await service.record(EDIT, { step: 'structure', kind: 'output', payload: { text: 'x'.repeat(500) } });
    const row = repository.rows[0];
    expect(row.payload).toEqual({ truncated: true, bytes: row.payloadBytes, sha256: row.payloadSha256 });
    expect(row.payloadBytes).toBeGreaterThan(500);
  });

  it('keeps a bare value and no payload as objects', async () => {
    process.env.AI_EDIT_TRACE = 'full';
    await service.record(EDIT, { step: 'create', kind: 'decision', payload: 5 });
    await service.record(EDIT, { step: 'create', kind: 'decision' });
    expect(repository.rows.map((row) => row.payload)).toEqual([{ value: 5 }, {}]);
  });

  it('looks the workspace up once per edit and writes nothing for an unknown edit', async () => {
    await service.record(EDIT, { step: 'create', kind: 'input' });
    await service.record(EDIT, { step: 'create', kind: 'output' });
    expect(repository.organizationLookups).toBe(1);
    await service.record('other-edit', { step: 'create', kind: 'input' });
    expect(repository.rows).toHaveLength(2);
  });

  it('swallows a repository error and never throws', async () => {
    repository.failAppend = new Error('connection lost');
    await expect(service.record(EDIT, { step: 'create', kind: 'input' })).resolves.toBeUndefined();
    expect((service as any)._logger.warn).toHaveBeenCalledWith(expect.stringContaining('Error'));
    expect((service as any)._logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('connection lost'));
  });

  it('swallows a failed workspace lookup too', async () => {
    repository.organizationOf = async () => {
      throw new Error('down');
    };
    await expect(service.record(EDIT, { step: 'create', kind: 'input' })).resolves.toBeUndefined();
  });
});

describe('ai.video-editing: TraceService.time', () => {
  let repository: FakeRepository;
  let service: TraceService;

  beforeEach(() => {
    delete process.env.AI_EDIT_TRACE;
    repository = new FakeRepository();
    service = new TraceService(repository as any);
    jest.spyOn((service as any)._logger, 'warn').mockImplementation(() => undefined);
  });

  it('answers the result of its function and records a metric row with the duration', async () => {
    await expect(service.time(EDIT, 'write', async () => 42, 3)).resolves.toBe(42);
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({ step: 'write', kind: 'metric', ok: true, attempt: 3 });
    expect(repository.rows[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('rethrows the error of its function after recording an error row with the class, not the message', async () => {
    const failure = Object.assign(new TypeError('private words in here'), { code: 'E_BAD' });
    await expect(
      service.time(EDIT, 'perceive', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(repository.rows).toHaveLength(1);
    const row = repository.rows[0];
    expect(row).toMatchObject({ step: 'perceive', kind: 'error', ok: false });
    expect(row.payload).toEqual({ error_class: 'TypeError', error_code: 'E_BAD', message_chars: 21 });
  });

  it('still answers and rethrows when the trace cannot be written', async () => {
    repository.failAppend = new Error('down');
    await expect(service.time(EDIT, 'write', () => 'ok')).resolves.toBe('ok');
    const failure = new Error('fn failed');
    await expect(
      service.time(EDIT, 'write', () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });

  it('runs its function and writes nothing in mode off', async () => {
    process.env.AI_EDIT_TRACE = 'off';
    try {
      await expect(service.time(EDIT, 'write', async () => 'ok')).resolves.toBe('ok');
      expect(repository.rows).toEqual([]);
    } finally {
      delete process.env.AI_EDIT_TRACE;
    }
  });
});

describe('ai.video-editing: TraceService retention and reads', () => {
  it('deletes the rows older than AI_EDIT_TRACE_DAYS days (365 by default)', async () => {
    const repository = new FakeRepository();
    const service = new TraceService(repository as any);
    const now = new Date('2026-11-22T03:00:00Z');
    delete process.env.AI_EDIT_TRACE_DAYS;
    await expect(service.deleteExpired(now)).resolves.toEqual({ deleted: 3 });
    expect(repository.deleted[0].toISOString()).toBe('2025-11-22T03:00:00.000Z');
    process.env.AI_EDIT_TRACE_DAYS = '30';
    try {
      await service.deleteExpired(now);
      expect(repository.deleted[1].toISOString()).toBe('2026-10-23T03:00:00.000Z');
    } finally {
      delete process.env.AI_EDIT_TRACE_DAYS;
    }
  });

  it('answers deleted 0 when the purge fails', async () => {
    const repository = new FakeRepository();
    repository.deleteCreatedBefore = async () => {
      throw new Error('down');
    };
    const service = new TraceService(repository as any);
    jest.spyOn((service as any)._logger, 'warn').mockImplementation(() => undefined);
    await expect(service.deleteExpired()).resolves.toEqual({ deleted: 0 });
  });

  it('reads with the workspace and the filter handed to the repository', async () => {
    const repository = new FakeRepository();
    repository.list.mockResolvedValue([]);
    const service = new TraceService(repository as any);
    await service.list(ORG, EDIT, { step: 'write' });
    expect(repository.list).toHaveBeenCalledWith(ORG, EDIT, { step: 'write' });
  });
});
