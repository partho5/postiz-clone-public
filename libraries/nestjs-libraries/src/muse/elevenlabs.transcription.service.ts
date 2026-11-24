// ElevenLabs Scribe v2 Transcribe Adapter: turns the speech audio of a recording, a WAV in R2,
// into text with microsecond word-level timings and grouped segments.
// Endpoint, parameters, and response structure adhere to ElevenLabs Speech-to-Text API:
// https://api.elevenlabs.io/v1/speech-to-text
import { Injectable, Logger } from '@nestjs/common';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { R2, R2_BUCKET } from '@gitroom/nestjs-libraries/upload/r2.uploader';
import { timer } from '@gitroom/helpers/utils/timer';
import {
  AiCaptionsNotConfigured,
  Transcription,
  TranscriptionProvider,
  TranscriptSegment,
  TranscriptWord,
} from '@gitroom/nestjs-libraries/muse/transcription.provider';

export const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
export const ELEVENLABS_MODEL = 'scribe_v2';

// How much of the file's start is read to inspect the WAV header
const HEADER_READ_BYTES = 64 * 1024;

// Timeout for transcription requests
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

// Retries on 429 and 5xx / network errors (up to 3 retries, exponential backoff)
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const STATUS_HINTS: Record<number, string> = {
  400: 'bad request or unsupported audio format',
  401: 'the API key was rejected',
  403: 'access forbidden or insufficient permissions',
  429: 'rate limit reached',
  500: 'internal server error',
  502: 'bad gateway',
  503: 'service unavailable',
};

// A failure during ElevenLabs transcription. `status` is the HTTP status code (0 for network/unreachable),
// `retryable` indicates if repeating the request with backoff may succeed.
export class ElevenLabsTranscribeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'ElevenLabsTranscribeError';
  }
}

// Maps a non-2xx HTTP status from ElevenLabs to an ElevenLabsTranscribeError.
// Redacts any occurrence of the API key from error output to guarantee secrets are never leaked.
export function elevenLabsError(status: number, body: string, apiKey?: string) {
  let sanitized = body;
  if (apiKey && apiKey.length > 4) {
    sanitized = sanitized.split(apiKey).join('[REDACTED]');
  }
  return new ElevenLabsTranscribeError(
    `ElevenLabs answered ${status} (${
      STATUS_HINTS[status] ?? 'unexpected'
    }): ${sanitized.slice(0, 300)}`,
    status,
    status === 429 || status >= 500
  );
}

// Parsed WAV header attributes.
export interface WavInfo {
  sampleRate: number;
  dataOffset: number;
  dataBytes: number;
  channels?: number;
  bytesPerSample?: number;
}

// Reads the WAV header from the leading bytes of an audio file (`objectSize` is the full file size).
// Supports standard PCM audio. When the data chunk size is unpatched (0 or past the end of the file),
// it infers the length from the remaining bytes.
export function parseWavHeader(head: Buffer, objectSize: number): WavInfo {
  const bad = (why: string) =>
    new ElevenLabsTranscribeError(
      `The audio is not a valid WAV: ${why}`,
      400,
      false
    );

  if (
    head.length < 12 ||
    head.toString('ascii', 0, 4) !== 'RIFF' ||
    head.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw bad('no RIFF/WAVE header');
  }

  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 16;
  let pos = 12;

  while (pos + 8 <= head.length) {
    const id = head.toString('ascii', pos, pos + 4);
    const size = head.readUInt32LE(pos + 4);
    const body = pos + 8;

    if (id === 'fmt ') {
      if (size < 16 || body + 16 > head.length) {
        throw bad('unreadable fmt chunk');
      }
      const format = head.readUInt16LE(body);
      channels = head.readUInt16LE(body + 2);
      sampleRate = head.readUInt32LE(body + 4);
      bitsPerSample = head.readUInt16LE(body + 14);

      if (format !== 1) {
        throw bad(`needs PCM audio, got format ${format}`);
      }
    } else if (id === 'data') {
      if (!sampleRate) {
        throw bad('data chunk before fmt chunk');
      }
      const bytesPerSample = Math.max(1, (bitsPerSample / 8) * channels);
      const left = objectSize - body;
      const length = size === 0 || size > left ? left : size;
      return {
        sampleRate,
        dataOffset: body,
        dataBytes: length - (length % bytesPerSample),
        channels,
        bytesPerSample,
      };
    }

    // Chunks are padded to an even number of bytes
    pos = body + size + (size % 2);
  }

  throw bad('no data chunk in the first bytes');
}

// Raw word token format returned by ElevenLabs Scribe API
export interface ElevenLabsWord {
  text: string;
  start: number;
  end: number;
  type: 'word' | 'spacing' | 'audio_event';
  speaker_id?: string;
}

// Raw JSON response structure from ElevenLabs Scribe API
export interface ElevenLabsResponse {
  text?: string;
  language_code?: string;
  language_probability?: number;
  words?: ElevenLabsWord[];
  audio_duration_secs?: number;
}

// Groups word tokens (excluding standalone spacing) into TranscriptSegment objects.
// Natural pause boundary: gap > 1.5s (1500ms).
// Maximum segment duration: 30s (30000ms).
// Also splits on speaker change when speaker tags are present.
export function groupWordsIntoSegments(
  words: TranscriptWord[]
): TranscriptSegment[] {
  const contentWords = words.filter((w) => w.type !== 'spacing');
  if (!contentWords.length) {
    return [];
  }

  const segments: TranscriptSegment[] = [];
  let currentWords: TranscriptWord[] = [];

  for (const word of contentWords) {
    if (currentWords.length > 0) {
      const prevWord = currentWords[currentWords.length - 1];
      const gapMs = word.startMs - prevWord.endMs;
      const durationMs = word.endMs - currentWords[0].startMs;
      const prevSpeaker = prevWord.speaker;
      const nextSpeaker = word.speaker;
      const speakerChanged =
        Boolean(prevSpeaker || nextSpeaker) && prevSpeaker !== nextSpeaker;

      if (gapMs > 1500 || durationMs > 30000 || speakerChanged) {
        segments.push({
          startMs: currentWords[0].startMs,
          endMs: prevWord.endMs,
          text: currentWords
            .map((w) => w.text)
            .join(' ')
            .trim(),
          ...(currentWords[0].speaker
            ? { speaker: currentWords[0].speaker }
            : {}),
          words: currentWords,
        });
        currentWords = [];
      }
    }
    currentWords.push(word);
  }

  if (currentWords.length > 0) {
    segments.push({
      startMs: currentWords[0].startMs,
      endMs: currentWords[currentWords.length - 1].endMs,
      text: currentWords
        .map((w) => w.text)
        .join(' ')
        .trim(),
      ...(currentWords[0].speaker ? { speaker: currentWords[0].speaker } : {}),
      words: currentWords,
    });
  }

  return segments;
}

@Injectable()
export class ElevenLabsTranscriptionService implements TranscriptionProvider {
  private readonly _logger = new Logger(ElevenLabsTranscriptionService.name);

  // The model id the usage ledger names.
  readonly model = ELEVENLABS_MODEL;

  // Whether ELEVEN_LABS_API_KEY (or ELEVENLABS_API_KEY) is configured
  isConfigured(): boolean {
    const key =
      process.env.ELEVEN_LABS_API_KEY?.trim() ||
      process.env.ELEVENLABS_API_KEY?.trim();
    return !!key;
  }

  // The duration of the audio in seconds, calculated directly from the WAV header in R2
  async audioSeconds(key: string): Promise<number> {
    const info = await this.readInfo(key);
    return info.dataBytes / (info.sampleRate * (info.bytesPerSample ?? 2));
  }

  // Transcribes the audio object stored under `key`.
  // Missing key: AiCaptionsNotConfigured (HTTP 503).
  // Non-recoverable failure: ElevenLabsTranscribeError.
  async transcribe(key: string): Promise<Transcription> {
    const apiKey = this.requireKey();
    const audioBuffer = await this.readFull(key);
    const info = parseWavHeader(audioBuffer, audioBuffer.length);
    const seconds =
      info.dataBytes / (info.sampleRate * (info.bytesPerSample ?? 2));

    if (info.dataBytes === 0) {
      return {
        text: '',
        segments: [],
        words: [],
        seconds: 0,
      };
    }

    const response = await this.postAudio(apiKey, audioBuffer);
    const fullText = response.text?.trim() || '';

    const words: TranscriptWord[] = (response.words || []).map((w) => ({
      text: w.text ?? '',
      startMs: Math.round((w.start ?? 0) * 1000),
      endMs: Math.round((w.end ?? 0) * 1000),
      type:
        w.type === 'spacing' || w.type === 'audio_event' ? w.type : 'word',
      ...(w.speaker_id ? { speaker: w.speaker_id } : {}),
    }));

    let segments = groupWordsIntoSegments(words);
    if (!segments.length && fullText) {
      segments = [
        {
          startMs: 0,
          endMs: Math.round(seconds * 1000),
          text: fullText,
        },
      ];
    }

    return {
      text: fullText || segments.map((s) => s.text).join(' '),
      ...(response.language_code ? { language: response.language_code } : {}),
      seconds,
      words,
      segments,
    };
  }

  // Returns the configured API key or throws AiCaptionsNotConfigured
  private requireKey(): string {
    const key =
      process.env.ELEVEN_LABS_API_KEY?.trim() ||
      process.env.ELEVENLABS_API_KEY?.trim();
    if (!key) {
      throw new AiCaptionsNotConfigured();
    }
    return key;
  }

  // Reads WAV header from the beginning of the stored object
  private async readInfo(key: string): Promise<WavInfo> {
    const { data, total } = await this.readRange(key, 0, HEADER_READ_BYTES);
    return parseWavHeader(data, total);
  }

  // Ranged GET for header inspection
  private async readRange(key: string, start: number, end: number) {
    const object = await R2.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Range: `bytes=${start}-${end - 1}`,
      })
    );
    const data = Buffer.from(await object.Body!.transformToByteArray());
    const total = Number(/\/(\d+)$/.exec(object.ContentRange || '')?.[1]);
    return { data, total: total || start + data.length };
  }

  // Reads the complete audio file from R2
  private async readFull(key: string): Promise<Buffer> {
    const object = await R2.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      })
    );
    return Buffer.from(await object.Body!.transformToByteArray());
  }

  // Sends audio to ElevenLabs with automatic retries on 429 and 5xx / network failures
  private async postAudio(
    apiKey: string,
    audioBuffer: Buffer
  ): Promise<ElevenLabsResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.postOnce(apiKey, audioBuffer);
      } catch (err) {
        lastError = err;
        const isRetryable =
          err instanceof ElevenLabsTranscribeError
            ? err.retryable
            : true;

        if (!isRetryable || attempt >= MAX_RETRIES) {
          throw err;
        }

        const status =
          err instanceof ElevenLabsTranscribeError ? err.status : 0;
        this._logger.warn(
          `ElevenLabs transcribe failed (${
            status || 'network error'
          }), retry ${attempt + 1}/${MAX_RETRIES}`
        );
        await timer(RETRY_DELAY_MS * 2 ** attempt);
      }
    }
    throw lastError;
  }

  // Performs a single HTTP request to ElevenLabs Scribe API
  private async postOnce(
    apiKey: string,
    audioBuffer: Buffer
  ): Promise<ElevenLabsResponse> {
    const formData = new FormData();
    formData.append('model_id', ELEVENLABS_MODEL);
    formData.append('diarize', 'true');
    formData.append('tag_audio_events', 'true');
    formData.append(
      'file',
      new Blob([audioBuffer], { type: 'audio/wav' }),
      'audio.wav'
    );

    let status: number;
    let bodyText: string;

    try {
      const res = await fetch(ELEVENLABS_URL, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
        },
        body: formData,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      bodyText = await res.text();
    } catch (cause) {
      let msg = cause instanceof Error ? cause.message : String(cause);
      if (apiKey && apiKey.length > 4) {
        msg = msg.split(apiKey).join('[REDACTED]');
      }
      throw new ElevenLabsTranscribeError(
        `ElevenLabs is unreachable: ${msg}`,
        0,
        true
      );
    }

    if (status < 200 || status >= 300) {
      throw elevenLabsError(status, bodyText, apiKey);
    }

    try {
      return JSON.parse(bodyText) as ElevenLabsResponse;
    } catch {
      throw new ElevenLabsTranscribeError(
        'ElevenLabs answered something that is not JSON',
        status,
        false
      );
    }
  }
}
