// Tests for ElevenLabsTranscriptionService: verifies audio duration calculation,
// WAV header parsing, word timestamp mapping, segment grouping, retry logic, error handling, and security.
import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  ELEVENLABS_MODEL,
  ELEVENLABS_URL,
  ElevenLabsTranscribeError,
  ElevenLabsTranscriptionService,
  elevenLabsError,
  groupWordsIntoSegments,
  parseWavHeader,
} from '@gitroom/nestjs-libraries/muse/elevenlabs.transcription.service';
import { wavHeader } from '@gitroom/nestjs-libraries/muse/muse.transcription.service';
import {
  AiCaptionsNotConfigured,
  TranscriptWord,
} from '@gitroom/nestjs-libraries/muse/transcription.provider';

const mockSend = jest.fn();

jest.mock('@gitroom/nestjs-libraries/upload/r2.uploader', () => ({
  R2: { send: (...args: unknown[]) => mockSend(...args) },
  R2_BUCKET: 'test-bucket',
}));

// No waiting between retries during tests
jest.mock('@gitroom/helpers/utils/timer', () => ({
  timer: () => Promise.resolve(),
}));

const RATE = 16000;
const BYTES_PER_SECOND = RATE * 2;
const KEY = 'test-audio.wav';

// Mono 16-bit PCM buffer of specified length in seconds
const pcm = (seconds: number, rate = RATE) => {
  return Buffer.alloc(Math.round(seconds * rate) * 2).fill(0x55);
};

// Full WAV buffer: RIFF header + fmt + data
const wavFile = (data: Buffer, rate = RATE) =>
  Buffer.concat([
    wavHeader(rate, data.length).subarray(0, 36),
    Buffer.from('data', 'ascii'),
    (() => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(data.length);
      return size;
    })(),
    data,
  ]);

// Mock R2 storing file, supporting both ranged GETs and full GETs
const storeFile = (file: Buffer) => {
  mockSend.mockImplementation(async (command: GetObjectCommand) => {
    if (command.input.Range) {
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(command.input.Range)!;
      const end = Math.min(Number(to), file.length - 1);
      const slice = file.subarray(Number(from), end + 1);
      return {
        Body: { transformToByteArray: async () => new Uint8Array(slice) },
        ContentRange: `bytes ${from}-${end}/${file.length}`,
      };
    }
    return {
      Body: { transformToByteArray: async () => new Uint8Array(file) },
      ContentLength: file.length,
    };
  });
};

const answer = (response: Record<string, unknown>) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(response),
});

const failure = (status: number, body = '{"error":"x"}') => ({
  ok: false,
  status,
  text: async () => body,
});

describe('ElevenLabs Scribe: WAV header parsing', () => {
  it('reads rate, channels, and dataBytes from valid PCM WAV', () => {
    const file = wavFile(pcm(10));
    const info = parseWavHeader(file, file.length);
    expect(info).toEqual({
      sampleRate: RATE,
      dataOffset: 44,
      dataBytes: 10 * BYTES_PER_SECOND,
      channels: 1,
      bytesPerSample: 2,
    });
  });

  it('infers dataBytes when data chunk length was unwritten (0)', () => {
    const file = wavFile(pcm(5));
    file.writeUInt32LE(0, 40);
    const info = parseWavHeader(file, file.length);
    expect(info.dataBytes).toBe(5 * BYTES_PER_SECOND);
  });

  it('rejects files without RIFF/WAVE header', () => {
    expect(() =>
      parseWavHeader(Buffer.from('not a wav header'), 16)
    ).toThrow(ElevenLabsTranscribeError);
  });

  it('rejects non-PCM WAV formats', () => {
    const file = wavFile(pcm(1));
    file.writeUInt16LE(3, 20); // IEEE float format
    expect(() => parseWavHeader(file, file.length)).toThrow(
      ElevenLabsTranscribeError
    );
  });
});

describe('ElevenLabs Scribe: word token grouping into segments', () => {
  it('filters standalone spacing tokens and groups words by natural pauses', () => {
    const words: TranscriptWord[] = [
      { text: 'Hello', startMs: 500, endMs: 900, type: 'word', speaker: 'spk_0' },
      { text: ' ', startMs: 900, endMs: 1000, type: 'spacing' },
      { text: 'world.', startMs: 1000, endMs: 1500, type: 'word', speaker: 'spk_0' },
      // 2.5s gap (> 1.5s natural pause threshold)
      { text: 'How', startMs: 4000, endMs: 4400, type: 'word', speaker: 'spk_0' },
      { text: 'are', startMs: 4450, endMs: 4700, type: 'word', speaker: 'spk_0' },
      { text: 'you?', startMs: 4750, endMs: 5200, type: 'word', speaker: 'spk_0' },
    ];

    const segments = groupWordsIntoSegments(words);
    expect(segments).toHaveLength(2);

    expect(segments[0]).toEqual({
      startMs: 500,
      endMs: 1500,
      text: 'Hello world.',
      speaker: 'spk_0',
      words: [
        { text: 'Hello', startMs: 500, endMs: 900, type: 'word', speaker: 'spk_0' },
        { text: 'world.', startMs: 1000, endMs: 1500, type: 'word', speaker: 'spk_0' },
      ],
    });

    expect(segments[1]).toEqual({
      startMs: 4000,
      endMs: 5200,
      text: 'How are you?',
      speaker: 'spk_0',
      words: [
        { text: 'How', startMs: 4000, endMs: 4400, type: 'word', speaker: 'spk_0' },
        { text: 'are', startMs: 4450, endMs: 4700, type: 'word', speaker: 'spk_0' },
        { text: 'you?', startMs: 4750, endMs: 5200, type: 'word', speaker: 'spk_0' },
      ],
    });
  });

  it('splits segments on speaker changes', () => {
    const words: TranscriptWord[] = [
      { text: 'First', startMs: 100, endMs: 500, type: 'word', speaker: 'spk_0' },
      { text: 'Second', startMs: 600, endMs: 1000, type: 'word', speaker: 'spk_1' },
    ];

    const segments = groupWordsIntoSegments(words);
    expect(segments).toHaveLength(2);
    expect(segments[0].speaker).toBe('spk_0');
    expect(segments[1].speaker).toBe('spk_1');
  });

  it('splits segments when continuous speech exceeds 30 seconds', () => {
    const words: TranscriptWord[] = [
      { text: 'Start', startMs: 0, endMs: 1000, type: 'word' },
      { text: 'Middle', startMs: 15000, endMs: 16000, type: 'word' },
      { text: 'End', startMs: 31000, endMs: 32000, type: 'word' },
    ];

    const segments = groupWordsIntoSegments(words);
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe('Start Middle');
    expect(segments[1].text).toBe('End');
  });

  it('returns empty array when given no words or only spacing', () => {
    expect(groupWordsIntoSegments([])).toEqual([]);
    expect(
      groupWordsIntoSegments([
        { text: ' ', startMs: 0, endMs: 100, type: 'spacing' },
      ])
    ).toEqual([]);
  });
});

describe('ElevenLabs Scribe: error mapping and sanitization', () => {
  it('marks 429 and 5xx as retryable and 4xx as non-retryable', () => {
    expect(elevenLabsError(400, 'bad').retryable).toBe(false);
    expect(elevenLabsError(401, 'unauthorized').retryable).toBe(false);
    expect(elevenLabsError(403, 'forbidden').retryable).toBe(false);
    expect(elevenLabsError(429, 'rate limit').retryable).toBe(true);
    expect(elevenLabsError(500, 'server error').retryable).toBe(true);
    expect(elevenLabsError(503, 'unavailable').retryable).toBe(true);
  });

  it('never leaks API key in error messages', () => {
    const secret = 'sk_elevenlabs_super_secret_key_12345';
    const error = elevenLabsError(401, `Failed key: ${secret}`, secret);
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain('[REDACTED]');
  });
});

describe('ElevenLabs Scribe: ElevenLabsTranscriptionService', () => {
  const service = new ElevenLabsTranscriptionService();
  const fetchMock = jest.fn();
  const realFetch = global.fetch;
  const envBackup = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockReset();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    delete process.env.ELEVEN_LABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    process.env.ELEVEN_LABS_API_KEY = 'test-elevenlabs-key';
  });

  afterAll(() => {
    global.fetch = realFetch;
    process.env = envBackup;
  });

  it('isConfigured() returns true when ELEVEN_LABS_API_KEY or ELEVENLABS_API_KEY is set', () => {
    process.env.ELEVEN_LABS_API_KEY = 'my-key';
    delete process.env.ELEVENLABS_API_KEY;
    expect(service.isConfigured()).toBe(true);

    delete process.env.ELEVEN_LABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = 'my-fallback-key';
    expect(service.isConfigured()).toBe(true);
  });

  it('isConfigured() returns false when API key is empty or unset', () => {
    delete process.env.ELEVEN_LABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    expect(service.isConfigured()).toBe(false);

    process.env.ELEVEN_LABS_API_KEY = '   ';
    expect(service.isConfigured()).toBe(false);
  });

  it('throws AiCaptionsNotConfigured (HTTP 503) without touching storage or network when unconfigured', async () => {
    delete process.env.ELEVEN_LABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;

    const error = await service.transcribe(KEY).catch((err) => err);
    expect(error).toBeInstanceOf(AiCaptionsNotConfigured);
    expect(error.getStatus()).toBe(503);
    expect(mockSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('audioSeconds(key) calculates exact audio duration from WAV header alone', async () => {
    storeFile(wavFile(pcm(150)));
    expect(await service.audioSeconds(KEY)).toBe(150);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input).toMatchObject({
      Bucket: 'test-bucket',
      Key: KEY,
      Range: 'bytes=0-65535',
    });
  });

  it('transcribe(key) parses response, converting seconds to ms, words, and segments', async () => {
    storeFile(wavFile(pcm(90)));

    fetchMock.mockResolvedValueOnce(
      answer({
        text: 'Hello world.',
        language_code: 'ben',
        words: [
          { text: 'Hello', start: 0.52, end: 1.15, type: 'word', speaker_id: 'spk_0' },
          { text: ' ', start: 1.15, end: 1.25, type: 'spacing' },
          { text: 'world.', start: 1.25, end: 2.05, type: 'word', speaker_id: 'spk_0' },
        ],
      })
    );

    const result = await service.transcribe(KEY);

    expect(result).toEqual({
      text: 'Hello world.',
      language: 'ben',
      seconds: 90,
      words: [
        { text: 'Hello', startMs: 520, endMs: 1150, type: 'word', speaker: 'spk_0' },
        { text: ' ', startMs: 1150, endMs: 1250, type: 'spacing' },
        { text: 'world.', startMs: 1250, endMs: 2050, type: 'word', speaker: 'spk_0' },
      ],
      segments: [
        {
          startMs: 520,
          endMs: 2050,
          text: 'Hello world.',
          speaker: 'spk_0',
          words: [
            { text: 'Hello', startMs: 520, endMs: 1150, type: 'word', speaker: 'spk_0' },
            { text: 'world.', startMs: 1250, endMs: 2050, type: 'word', speaker: 'spk_0' },
          ],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ELEVENLABS_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['xi-api-key']).toBe('test-elevenlabs-key');

    const body = init.body as FormData;
    expect(body.get('model_id')).toBe(ELEVENLABS_MODEL);
    expect(body.get('diarize')).toBe('true');
    expect(body.get('tag_audio_events')).toBe('true');
    expect(body.get('file')).toBeDefined();
  });

  it('retries on 429 rate limit with exponential backoff and succeeds', async () => {
    storeFile(wavFile(pcm(30)));
    fetchMock
      .mockResolvedValueOnce(failure(429, 'Rate limited'))
      .mockResolvedValueOnce(failure(429, 'Rate limited'))
      .mockResolvedValueOnce(
        answer({
          text: 'Success after retry.',
          words: [{ text: 'Success', start: 0, end: 1, type: 'word' }],
        })
      );

    const result = await service.transcribe(KEY);
    expect(result.text).toBe('Success after retry.');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails immediately on 401 unauthorized without retrying', async () => {
    storeFile(wavFile(pcm(30)));
    fetchMock.mockResolvedValueOnce(failure(401, 'Unauthorized API key'));

    const error = await service.transcribe(KEY).catch((err) => err);
    expect(error).toBeInstanceOf(ElevenLabsTranscribeError);
    expect(error.status).toBe(401);
    expect(error.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx up to 3 times before failing', async () => {
    storeFile(wavFile(pcm(30)));
    fetchMock.mockResolvedValue(failure(500, 'Internal Server Error'));

    const error = await service.transcribe(KEY).catch((err) => err);
    expect(error).toBeInstanceOf(ElevenLabsTranscribeError);
    expect(error.status).toBe(500);
    // 1 initial try + 3 retries = 4 total calls
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries on network timeout / unreachable before failing', async () => {
    storeFile(wavFile(pcm(30)));
    fetchMock.mockRejectedValue(new Error('Connection timed out'));

    const error = await service.transcribe(KEY).catch((err) => err);
    expect(error).toBeInstanceOf(ElevenLabsTranscribeError);
    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('returns empty transcription for empty audio without calling ElevenLabs', async () => {
    storeFile(wavFile(Buffer.alloc(0)));
    const result = await service.transcribe(KEY);
    expect(result).toEqual({
      text: '',
      segments: [],
      words: [],
      seconds: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a single segment covering the audio when words array is omitted but text is present', async () => {
    storeFile(wavFile(pcm(10)));
    fetchMock.mockResolvedValueOnce(
      answer({
        text: 'Speech with no word timings.',
      })
    );

    const result = await service.transcribe(KEY);
    expect(result.text).toBe('Speech with no word timings.');
    expect(result.segments).toEqual([
      {
        startMs: 0,
        endMs: 10000,
        text: 'Speech with no word timings.',
      },
    ]);
  });
});
