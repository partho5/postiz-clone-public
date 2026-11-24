// ai.video-captions (AC4): the transcription of a caption job's speech audio. Needs no network and no database:
// R2 is a Buffer behind a mocked ranged GET and Muse is a mocked fetch. Covers the WAV header, the plan of pieces
// on synthetic PCM, the header rebuilt per piece, the join of the answers by offset, and the error mapping.
import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  MUSE_PIECE_MAX_BYTES,
  MUSE_PIECE_MAX_MS,
  MuseTranscribeError,
  MuseTranscriptionService,
  museError,
  museRequestBody,
  parseWavHeader,
  pieceResult,
  planPieces,
  quietestCut,
  wavHeader,
} from '@gitroom/nestjs-libraries/muse/muse.transcription.service';
import { AiCaptionsNotConfigured } from '@gitroom/nestjs-libraries/muse/transcription.provider';

const mockSend = jest.fn();

jest.mock('@gitroom/nestjs-libraries/upload/r2.uploader', () => ({
  R2: { send: (...args: unknown[]) => mockSend(...args) },
  R2_BUCKET: 'test-bucket',
}));

// No waiting between retries
jest.mock('@gitroom/helpers/utils/timer', () => ({
  timer: () => Promise.resolve(),
}));

const RATE = 16000;
const BYTES_PER_SECOND = RATE * 2;
const KEY = 'audio-key.wav';

// Samples -8000 and 8000 in turn, the loudness every synthetic audio here starts with
const LOUD = Buffer.from([0xc0, 0xe0, 0x40, 0x1f]);

// Mono 16-bit PCM of `seconds`, loud everywhere except the `quiet` stretches (in seconds, [from, to]) which are silent.
const pcm = (seconds: number, quiet: [number, number][] = [], rate = RATE) => {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2).fill(LOUD);
  for (const [from, to] of quiet) {
    data.fill(0, Math.round(from * rate) * 2, Math.round(to * rate) * 2);
  }
  return data;
};

// A whole WAV file: the header, optionally another chunk before the data, then the samples.
const wavFile = (data: Buffer, rate = RATE, extraChunk?: Buffer) =>
  Buffer.concat([
    wavHeader(rate, data.length).subarray(0, 36),
    ...(extraChunk ? [extraChunk] : []),
    Buffer.from('data', 'ascii'),
    (() => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(data.length);
      return size;
    })(),
    data,
  ]);

// R2 holding `file`: answers a ranged GET with the slice and the object's size in Content-Range.
const storeFile = (file: Buffer) => {
  mockSend.mockImplementation(async (command: GetObjectCommand) => {
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(command.input.Range!)!;
    const end = Math.min(Number(to), file.length - 1);
    const slice = file.subarray(Number(from), end + 1);
    return {
      Body: { transformToByteArray: async () => new Uint8Array(slice) },
      ContentRange: `bytes ${from}-${end}/${file.length}`,
    };
  });
};

const answer = (transcript: string, turns: unknown[] = []) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ transcript, audioDurationMs: 1, turns }),
});
const failure = (status: number, body = '{"error":"x"}') => ({
  ok: false,
  status,
  text: async () => body,
});

describe('ai.video-captions: the WAV header', () => {
  it('reads the rate and where the samples are', () => {
    const file = wavFile(pcm(1));
    expect(parseWavHeader(file, file.length)).toEqual({
      sampleRate: RATE,
      dataOffset: 44,
      dataBytes: BYTES_PER_SECOND,
    });
  });

  it('skips a chunk before the data, padded to an even length', () => {
    const list = Buffer.concat([
      Buffer.from('LIST', 'ascii'),
      Buffer.from([3, 0, 0, 0]),
      Buffer.from([1, 2, 3, 0]),
    ]);
    const file = wavFile(pcm(1), RATE, list);
    expect(parseWavHeader(file, file.length)).toMatchObject({
      dataOffset: 44 + 12,
      dataBytes: BYTES_PER_SECOND,
    });
  });

  it('takes the rest of the file when the data length was never written', () => {
    const file = wavFile(pcm(1));
    for (const unwritten of [0, 0xffffffff]) {
      file.writeUInt32LE(unwritten, 40);
      expect(parseWavHeader(file, file.length).dataBytes).toBe(BYTES_PER_SECOND);
    }
  });

  it('reads 24 kHz too', () => {
    const file = wavFile(pcm(1, [], 24000), 24000);
    expect(parseWavHeader(file, file.length)).toMatchObject({
      sampleRate: 24000,
      dataBytes: 48000,
    });
  });

  it.each([
    ['stereo', (h: Buffer) => h.writeUInt16LE(2, 22)],
    ['8-bit', (h: Buffer) => h.writeUInt16LE(8, 34)],
    ['44.1 kHz', (h: Buffer) => h.writeUInt32LE(44100, 24)],
    ['float samples', (h: Buffer) => h.writeUInt16LE(3, 20)],
  ])('refuses %s, which Muse does not take', (_name, change) => {
    const file = wavFile(pcm(1));
    change(file);
    expect(() => parseWavHeader(file, file.length)).toThrow(MuseTranscribeError);
  });

  it('refuses a file that is not a WAV, and a header with no data chunk', () => {
    expect(() => parseWavHeader(Buffer.from('not a wav at all'), 16)).toThrow(
      MuseTranscribeError
    );
    const noData = wavHeader(RATE, 0).subarray(0, 36);
    expect(() => parseWavHeader(noData, noData.length)).toThrow(
      MuseTranscribeError
    );
  });

  it('rebuilds a header whose lengths match the piece', () => {
    const header = wavHeader(24000, 1000);
    const file = Buffer.concat([header, Buffer.alloc(1000)]);
    expect(header.length).toBe(44);
    expect(header.readUInt32LE(4)).toBe(36 + 1000);
    expect(header.readUInt32LE(28)).toBe(48000);
    expect(parseWavHeader(file, file.length)).toEqual({
      sampleRate: 24000,
      dataOffset: 44,
      dataBytes: 1000,
    });
  });
});

describe('ai.video-captions: where a piece is cut', () => {
  it('cuts in the middle of the quietest stretch', () => {
    const window = pcm(20, [[12, 12.6]]);
    const cut = quietestCut(window, RATE);
    expect(cut % 2).toBe(0);
    expect(cut).toBeGreaterThanOrEqual(12 * BYTES_PER_SECOND);
    expect(cut).toBeLessThanOrEqual(12.6 * BYTES_PER_SECOND);
  });

  it('copes with a window shorter than the stretch it looks for', () => {
    expect(quietestCut(Buffer.alloc(0), RATE)).toBe(0);
    expect(quietestCut(pcm(0.05), RATE)).toBeLessThanOrEqual(0.05 * BYTES_PER_SECOND);
  });
});

describe('ai.video-captions: the plan of pieces', () => {
  // Reads a range of the samples
  const reader = (data: Buffer) => async (start: number, end: number) =>
    data.subarray(start, end);

  it('keeps the limits at 9.5 minutes and 30 MB', () => {
    expect(MUSE_PIECE_MAX_MS).toBe(9.5 * 60 * 1000);
    expect(MUSE_PIECE_MAX_BYTES).toBe(30_000_000);
  });

  it('sends a short audio as one piece, and one exactly at the limit too', async () => {
    const data = pcm(60);
    expect(
      await planPieces({ sampleRate: RATE, dataBytes: data.length }, reader(data))
    ).toEqual([{ start: 0, end: data.length }]);

    const limit = 570 * BYTES_PER_SECOND;
    expect(
      await planPieces({ sampleRate: RATE, dataBytes: limit }, async () => {
        throw new Error('nothing to cut');
      })
    ).toEqual([{ start: 0, end: limit }]);
  });

  it('cuts a long audio in the quiet stretch before each limit, with no gap or overlap', async () => {
    // 25 minutes with a quiet stretch 10 s before each 9.5 minute mark
    const data = pcm(1500, [
      [560, 560.6],
      [1120, 1120.6],
    ]);
    const pieces = await planPieces(
      { sampleRate: RATE, dataBytes: data.length },
      reader(data)
    );

    expect(pieces).toHaveLength(3);
    expect(pieces[0].start).toBe(0);
    expect(pieces[2].end).toBe(data.length);
    for (let i = 0; i < pieces.length; i++) {
      expect(pieces[i].end - pieces[i].start).toBeLessThanOrEqual(
        570 * BYTES_PER_SECOND
      );
      expect(pieces[i].end - pieces[i].start).toBeLessThanOrEqual(
        MUSE_PIECE_MAX_BYTES
      );
      expect(pieces[i].end % 2).toBe(0);
      if (i) {
        expect(pieces[i].start).toBe(pieces[i - 1].end);
      }
    }
    expect(pieces[0].end).toBeGreaterThanOrEqual(560 * BYTES_PER_SECOND);
    expect(pieces[0].end).toBeLessThanOrEqual(560.6 * BYTES_PER_SECOND);
    expect(pieces[1].end).toBeGreaterThanOrEqual(1120 * BYTES_PER_SECOND);
    expect(pieces[1].end).toBeLessThanOrEqual(1120.6 * BYTES_PER_SECOND);
  });

  it('reads only the last 20 seconds before a limit to find the cut', async () => {
    const data = pcm(700);
    const read = jest.fn(reader(data));
    await planPieces({ sampleRate: RATE, dataBytes: data.length }, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(
      (570 - 20) * BYTES_PER_SECOND,
      570 * BYTES_PER_SECOND
    );
  });

  it('plans 24 kHz audio by the same rules', async () => {
    const data = pcm(1200, [[560, 560.6]], 24000);
    const pieces = await planPieces(
      { sampleRate: 24000, dataBytes: data.length },
      reader(data)
    );
    expect(pieces).toHaveLength(3);
    for (const piece of pieces) {
      expect(piece.end - piece.start).toBeLessThanOrEqual(MUSE_PIECE_MAX_BYTES);
    }
  });
});

describe('ai.video-captions: the join of the answers', () => {
  it('moves the turns by the piece offset and drops empty ones', () => {
    const result = pieceResult(
      {
        transcript: ' Hello there. Second turn. ',
        turns: [
          { startMs: 100, endMs: 900, transcript: 'Hello there.' },
          { startMs: 1000, endMs: 1100, transcript: '  ' },
          { startMs: 1200, endMs: 2000, transcript: 'Second turn.', speaker: 'A' },
        ],
      },
      570_000,
      30_000
    );
    expect(result.text).toBe('Hello there. Second turn.');
    expect(result.segments).toEqual([
      { startMs: 570_100, endMs: 570_900, text: 'Hello there.' },
      { startMs: 571_200, endMs: 572_000, text: 'Second turn.', speaker: 'A' },
    ]);
  });

  it('turns an answer with text but no turns into one segment over the piece', () => {
    expect(pieceResult({ transcript: 'All of it' }, 5000, 2000)).toEqual({
      text: 'All of it',
      segments: [{ startMs: 5000, endMs: 7000, text: 'All of it' }],
    });
  });

  it('gives nothing for silence', () => {
    expect(pieceResult({ transcript: '', turns: [] }, 0, 1000)).toEqual({
      text: '',
      segments: [],
    });
    expect(pieceResult({}, 0, 1000)).toEqual({ text: '', segments: [] });
  });
});

describe('ai.video-captions: the request', () => {
  it('is written as Meta documents it: the settings without a filename, then the WAV', () => {
    const header = wavHeader(RATE, 4);
    const body = museRequestBody('B0UND', header, Buffer.from([1, 2, 3, 4]));
    const text = body.toString('latin1');
    expect(
      text.startsWith(
        '--B0UND\r\nContent-Disposition: form-data; name="request"\r\n' +
          'Content-Type: application/json\r\n\r\n'
      )
    ).toBe(true);
    expect(text).toContain(
      '{"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","mode":"ENDPOINTING"}'
    );
    expect(text).toContain(
      'name="audio"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF'
    );
    expect(text.endsWith('\r\n--B0UND--\r\n')).toBe(true);
    // the piece's header and samples are in the body as they are
    expect(body.includes(Buffer.concat([header, Buffer.from([1, 2, 3, 4])]))).toBe(true);
  });
});

describe('ai.video-captions: the error mapping', () => {
  it.each([
    [400, false],
    [401, false],
    [413, false],
    [429, true],
    [500, true],
    [503, true],
  ])('maps a %p answer (retryable: %p)', (status, retryable) => {
    const error = museError(status, 'body');
    expect(error).toBeInstanceOf(MuseTranscribeError);
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(retryable);
    expect(error.message).toContain(String(status));
  });

  it('keeps only the start of a long body in the message', () => {
    expect(museError(500, 'x'.repeat(5000)).message.length).toBeLessThan(400);
  });
});

describe('ai.video-captions: MuseTranscriptionService', () => {
  const service = new MuseTranscriptionService();
  const fetchMock = jest.fn();
  const realFetch = global.fetch;
  const realKey = process.env.META_MUSE_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockReset();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.META_MUSE_API_KEY = 'muse-key';
  });

  afterAll(() => {
    global.fetch = realFetch;
    if (realKey === undefined) {
      delete process.env.META_MUSE_API_KEY;
    } else {
      process.env.META_MUSE_API_KEY = realKey;
    }
  });

  it('answers 503 AI_CAPTIONS_NOT_CONFIGURED without touching storage or Muse when the key is empty', async () => {
    for (const empty of ['', '   ', undefined]) {
      if (empty === undefined) {
        delete process.env.META_MUSE_API_KEY;
      } else {
        process.env.META_MUSE_API_KEY = empty;
      }
      expect(service.isConfigured()).toBe(false);
      const error = await service.transcribe(KEY).catch((err) => err);
      expect(error).toBeInstanceOf(AiCaptionsNotConfigured);
      expect(error.getStatus()).toBe(503);
      expect(error.getResponse().code).toBe('AI_CAPTIONS_NOT_CONFIGURED');
    }
    expect(mockSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the length from the header alone', async () => {
    storeFile(wavFile(pcm(150)));
    expect(service.isConfigured()).toBe(true);
    expect(await service.audioSeconds(KEY)).toBe(150);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input).toMatchObject({
      Bucket: 'test-bucket',
      Key: KEY,
      Range: 'bytes=0-65535',
    });
  });

  it('sends a short audio as one WAV and returns the text, the turns and the length', async () => {
    storeFile(wavFile(pcm(90)));
    fetchMock.mockResolvedValue(
      answer('Hello world.', [{ startMs: 500, endMs: 1500, transcript: 'Hello world.' }])
    );

    const result = await service.transcribe(KEY);

    expect(result).toEqual({
      text: 'Hello world.',
      segments: [{ startMs: 500, endMs: 1500, text: 'Hello world.' }],
      seconds: 90,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.meta.ai/v1/asr/transcribe');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer muse-key');
    expect(init.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=muse/);
    // the one piece is the whole audio under a rebuilt header
    const sent: Buffer = init.body;
    const at = sent.indexOf('RIFF');
    expect(parseWavHeader(sent.subarray(at), sent.length - at)).toMatchObject({
      sampleRate: RATE,
      dataBytes: 90 * BYTES_PER_SECOND,
    });
  });

  it('splits a long audio, rebuilds a header per piece and joins the answers on the recording clock', async () => {
    // 12 minutes with a quiet stretch 10 s before the 9.5 minute mark
    storeFile(wavFile(pcm(720, [[560, 560.6]])));
    fetchMock
      .mockResolvedValueOnce(
        answer('First part.', [{ startMs: 1000, endMs: 2000, transcript: 'First part.' }])
      )
      .mockResolvedValueOnce(
        answer('Second part.', [{ startMs: 1000, endMs: 2000, transcript: 'Second part.' }])
      );

    const result = await service.transcribe(KEY);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sizes = fetchMock.mock.calls.map(([, init]) => {
      const sent: Buffer = init.body;
      const at = sent.indexOf('RIFF');
      return parseWavHeader(sent.subarray(at), sent.length - at).dataBytes;
    });
    expect(sizes[0] + sizes[1]).toBe(720 * BYTES_PER_SECOND);
    expect(sizes[0]).toBeLessThanOrEqual(570 * BYTES_PER_SECOND);
    expect(sizes[0]).toBeGreaterThanOrEqual(560 * BYTES_PER_SECOND);

    const secondOffsetMs = Math.round((sizes[0] / BYTES_PER_SECOND) * 1000);
    expect(result.text).toBe('First part. Second part.');
    expect(result.seconds).toBe(720);
    expect(result.segments).toEqual([
      { startMs: 1000, endMs: 2000, text: 'First part.' },
      { startMs: secondOffsetMs + 1000, endMs: secondOffsetMs + 2000, text: 'Second part.' },
    ]);
  });

  it('retries a 429 with backoff, and a 5xx once', async () => {
    storeFile(wavFile(pcm(30)));
    fetchMock
      .mockResolvedValueOnce(failure(429))
      .mockResolvedValueOnce(failure(429))
      .mockResolvedValueOnce(answer('Fine.'));
    expect((await service.transcribe(KEY)).text).toBe('Fine.');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(failure(500));
    const error = await service.transcribe(KEY).catch((err) => err);
    expect(error).toBeInstanceOf(MuseTranscribeError);
    expect(error.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a request that got no answer once, then gives up', async () => {
    storeFile(wavFile(pcm(30)));
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    const error = await service.transcribe(KEY).catch((err) => err);
    expect(error).toBeInstanceOf(MuseTranscribeError);
    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry an answer that will not change', async () => {
    storeFile(wavFile(pcm(30)));
    for (const status of [400, 401, 413]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(failure(status));
      const error = await service.transcribe(KEY).catch((err) => err);
      expect(error).toBeInstanceOf(MuseTranscribeError);
      expect(error.status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses a WAV Muse cannot take before sending anything', async () => {
    const stereo = wavFile(pcm(30));
    stereo.writeUInt16LE(2, 22);
    storeFile(stereo);
    const error = await service.transcribe(KEY).catch((err) => err);
    expect(error).toBeInstanceOf(MuseTranscribeError);
    expect(error.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers an empty audio without calling Muse', async () => {
    storeFile(wavFile(Buffer.alloc(0)));
    expect(await service.transcribe(KEY)).toEqual({ text: '', segments: [], seconds: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
