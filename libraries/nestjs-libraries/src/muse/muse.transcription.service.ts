// Meta Muse Transcribe (ai.video-captions): turns the speech audio of a recording, a 16-bit mono WAV in R2, into
// text with timings. Muse takes one WAV of at most 10 minutes and 32 MB per request, so a longer audio is read
// from R2 in ranged GETs (never whole in memory), cut into pieces at the quietest moment near each limit, sent
// one after the other, and the answers are joined with their times moved to the recording's clock.
// Endpoint, limits and field names are from Meta's official docs (https://dev.meta.ai/docs/speech-to-text,
// checked 2026-10-21).
import { Injectable, Logger } from '@nestjs/common';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { R2, R2_BUCKET } from '@gitroom/nestjs-libraries/upload/r2.uploader';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { timer } from '@gitroom/helpers/utils/timer';
import {
  AiCaptionsNotConfigured,
  Transcription,
  TranscriptionProvider,
  TranscriptSegment,
} from '@gitroom/nestjs-libraries/muse/transcription.provider';

const MUSE_URL = 'https://api.meta.ai/v1/asr/transcribe';
const MUSE_MODEL = 'muse-voice-transcribe-1.0';
// ENDPOINTING answers the speech as timed turns; the default PUSH_TO_TALK answers the whole clip with no turns
const MUSE_MODE = 'ENDPOINTING';

// Muse takes at most 10 minutes and 32 MB per request; a piece stays under both with room to spare.
export const MUSE_PIECE_MAX_MS = 9.5 * 60 * 1000;
export const MUSE_PIECE_MAX_BYTES = 30_000_000;

// The sample rates Muse takes, and the one sample size (16-bit mono) the WAV must have: a byte rate of rate * 2.
const SAMPLE_RATES = [16000, 24000];
const BYTES_PER_SAMPLE = 2;

// A cut is made in the quietest CUT_WINDOW_MS of the last CUT_SEARCH_MS before a piece's limit, where no word is.
const CUT_SEARCH_MS = 20_000;
const CUT_WINDOW_MS = 200;

// A piece shorter than this (a few samples left after a cut) is not sent.
const MIN_PIECE_MS = 100;

// How much of the file's start is read to find the WAV header; the data chunk follows any other chunks.
const HEADER_READ_BYTES = 64 * 1024;

// One request is abandoned after this long (a 10 minute piece takes Muse a while).
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
// Retries after the first attempt, and the wait before the first one (it doubles per retry). Meta: back off and
// retry on 429; retry a 500 once.
const RATE_LIMIT_RETRIES = 3;
const SERVER_RETRIES = 1;
const RETRY_DELAY_MS = 1000;

const STATUS_HINTS: Record<number, string> = {
  400: 'not a supported WAV, or over 10 minutes',
  401: 'the API key was rejected',
  403: 'the API key was rejected',
  406: 'unsupported Accept header',
  413: 'request over 32 MB',
  429: 'rate or concurrency limit reached',
  500: 'transcription failed or exceeded the server budget',
};

// A failure of the transcription. `status` is the HTTP status Muse answered (400 for audio we refuse ourselves,
// 0 when no answer came), `retryable` whether the same request may work later (429, 5xx, no answer).
export class MuseTranscribeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'MuseTranscribeError';
  }
}

// The error for a non-2xx answer of Muse.
export function museError(status: number, body: string) {
  return new MuseTranscribeError(
    `Muse answered ${status} (${
      STATUS_HINTS[status] ?? 'unexpected'
    }): ${body.slice(0, 300)}`,
    status,
    status === 429 || status >= 500
  );
}

// Where the samples of a WAV are: the sample rate, and the data chunk's offset and length in bytes.
export interface WavInfo {
  sampleRate: number;
  dataOffset: number;
  dataBytes: number;
}

// Reads the header of a WAV from the first bytes of its file (`objectSize` is the whole file's size). Refuses
// anything but mono 16-bit PCM at 16 or 24 kHz, the one thing Muse takes. A data length of 0 or one past the end
// of the file (a header never patched after recording) means the rest of the file.
export function parseWavHeader(head: Buffer, objectSize: number): WavInfo {
  const bad = (why: string) =>
    new MuseTranscribeError(
      `The audio is not a WAV Muse accepts: ${why}`,
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
      const channels = head.readUInt16LE(body + 2);
      const bits = head.readUInt16LE(body + 14);
      sampleRate = head.readUInt32LE(body + 4);
      if (
        format !== 1 ||
        channels !== 1 ||
        bits !== 16 ||
        !SAMPLE_RATES.includes(sampleRate)
      ) {
        throw bad(
          `needs mono 16-bit PCM at 16 or 24 kHz, got format ${format}, ${channels} channel(s), ${bits}-bit, ${sampleRate} Hz`
        );
      }
    } else if (id === 'data') {
      if (!sampleRate) {
        throw bad('data chunk before fmt chunk');
      }
      const left = objectSize - body;
      const length = size === 0 || size > left ? left : size;
      return {
        sampleRate,
        dataOffset: body,
        dataBytes: length - (length % BYTES_PER_SAMPLE),
      };
    }
    // chunks are padded to an even length
    pos = body + size + (size % 2);
  }
  throw bad('no data chunk in the first bytes');
}

// A 44-byte WAV header for `dataBytes` of mono 16-bit PCM: the header of one piece.
export function wavHeader(sampleRate: number, dataBytes: number) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

// Where to cut inside `window` (mono 16-bit PCM): the middle of its quietest CUT_WINDOW_MS (least energy; the
// latest of equals, so pieces stay long), as a byte offset from the window's start, on a sample boundary.
export function quietestCut(window: Buffer, sampleRate: number) {
  const samples = Math.floor(window.length / BYTES_PER_SAMPLE);
  if (!samples) {
    return 0;
  }
  const span = Math.min(
    samples,
    Math.round((sampleRate * CUT_WINDOW_MS) / 1000)
  );
  let energy = 0;
  let least = Infinity;
  let leastAt = 0;
  for (let i = 0; i < samples; i++) {
    const sample = window.readInt16LE(i * BYTES_PER_SAMPLE);
    energy += sample * sample;
    if (i >= span) {
      const old = window.readInt16LE((i - span) * BYTES_PER_SAMPLE);
      energy -= old * old;
    }
    if (i >= span - 1 && energy <= least) {
      least = energy;
      leastAt = i - span + 1;
    }
  }
  return (leastAt + Math.floor(span / 2)) * BYTES_PER_SAMPLE;
}

// One piece: byte offsets inside the data chunk, `start` included and `end` not.
export interface WavPiece {
  start: number;
  end: number;
}

// Plans the pieces of `dataBytes` of audio, each at most MUSE_PIECE_MAX_MS and MUSE_PIECE_MAX_BYTES. A piece that
// would end past its limit is cut instead in the quietest moment of the last CUT_SEARCH_MS before it, found by
// reading just that window with `readData(start, end)`. Pieces follow one another with no gap or overlap.
export async function planPieces(
  info: Pick<WavInfo, 'sampleRate' | 'dataBytes'>,
  readData: (start: number, end: number) => Promise<Buffer>
): Promise<WavPiece[]> {
  const byteRate = info.sampleRate * BYTES_PER_SAMPLE;
  const maxBytes =
    Math.floor(
      Math.min((MUSE_PIECE_MAX_MS * byteRate) / 1000, MUSE_PIECE_MAX_BYTES) /
        BYTES_PER_SAMPLE
    ) * BYTES_PER_SAMPLE;
  const searchBytes = Math.round((CUT_SEARCH_MS * byteRate) / 1000);

  const pieces: WavPiece[] = [];
  let start = 0;
  while (info.dataBytes - start > maxBytes) {
    const limit = start + maxBytes;
    const from = Math.max(start, limit - searchBytes);
    const end =
      from + quietestCut(await readData(from, limit), info.sampleRate);
    // a cut at the piece's own start would never move on
    pieces.push({ start, end: end > start ? end : limit });
    start = pieces[pieces.length - 1].end;
  }
  pieces.push({ start, end: info.dataBytes });
  return pieces;
}

// The body of one request, `multipart/form-data` as Meta documents it: a `request` part with the settings (JSON, no
// filename) and an `audio` part with the WAV (the piece's header, then its samples).
export function museRequestBody(boundary: string, header: Buffer, data: Buffer) {
  const settings = JSON.stringify({
    model: MUSE_MODEL,
    audioEncoding: 'WAV',
    mode: MUSE_MODE,
  });
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${settings}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
    ),
    header,
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

// What Muse answers (application/json); there is no language, `text` or `segments` field.
export interface MuseAnswer {
  transcript?: string;
  audioDurationMs?: number;
  turns?: {
    startMs: number;
    endMs: number;
    transcript?: string;
    speaker?: string;
  }[];
}

// The text and timed segments of one piece's answer, with the times moved by the piece's offset in the recording.
// An answer with text but no turns is one segment over the whole piece.
export function pieceResult(
  answer: MuseAnswer,
  offsetMs: number,
  pieceMs: number
) {
  const text = answer.transcript?.trim() || '';
  const segments: TranscriptSegment[] = (answer.turns || [])
    .filter((turn) => turn.transcript?.trim())
    .map((turn) => ({
      startMs: offsetMs + turn.startMs,
      endMs: offsetMs + turn.endMs,
      text: turn.transcript!.trim(),
      ...(turn.speaker ? { speaker: turn.speaker } : {}),
    }));
  if (!segments.length && text) {
    segments.push({ startMs: offsetMs, endMs: offsetMs + pieceMs, text });
  }
  return { text: text || segments.map((s) => s.text).join(' '), segments };
}

@Injectable()
export class MuseTranscriptionService implements TranscriptionProvider {
  private readonly _logger = new Logger(MuseTranscriptionService.name);

  // The model id the usage ledger names.
  readonly model = MUSE_MODEL;

  // Whether META_MUSE_API_KEY is set (an app-level key, not a workspace credential).
  isConfigured() {
    return !!process.env.META_MUSE_API_KEY?.trim();
  }

  // The length in seconds of the audio stored under `key`, from its WAV header alone (one small ranged GET). The
  // caption job charges by this, never by what the client says.
  async audioSeconds(key: string) {
    const info = await this.readInfo(key);
    return info.dataBytes / (info.sampleRate * BYTES_PER_SAMPLE);
  }

  // Transcribes the audio stored under `key`. Missing key: AiCaptionsNotConfigured. A WAV Muse cannot take, or a
  // Muse answer that is not a success after the retries: MuseTranscribeError.
  async transcribe(key: string): Promise<Transcription> {
    const apiKey = this.requireKey();
    const info = await this.readInfo(key);
    const byteRate = info.sampleRate * BYTES_PER_SAMPLE;
    const minBytes = (MIN_PIECE_MS * byteRate) / 1000;
    const pieces = (
      await planPieces(info, (start, end) =>
        this.readData(key, info, start, end)
      )
    ).filter((piece) => piece.end - piece.start >= minBytes);

    const texts: string[] = [];
    const segments: TranscriptSegment[] = [];
    for (const piece of pieces) {
      const data = await this.readData(key, info, piece.start, piece.end);
      const answer = await this.postPiece(
        apiKey,
        wavHeader(info.sampleRate, data.length),
        data
      );
      const result = pieceResult(
        answer,
        Math.round((piece.start / byteRate) * 1000),
        Math.round((data.length / byteRate) * 1000)
      );
      if (result.text) {
        texts.push(result.text);
      }
      segments.push(...result.segments);
    }
    return {
      text: texts.join(' '),
      segments,
      seconds: info.dataBytes / byteRate,
    };
  }

  // The key from the env, or AiCaptionsNotConfigured when it is empty.
  private requireKey() {
    const key = process.env.META_MUSE_API_KEY?.trim();
    if (!key) {
      throw new AiCaptionsNotConfigured();
    }
    return key;
  }

  // The WAV header of the stored audio, read from its first bytes.
  private async readInfo(key: string) {
    const { data, total } = await this.readRange(key, 0, HEADER_READ_BYTES);
    return parseWavHeader(data, total);
  }

  // `start` to `end` (not included) of the samples in the stored audio; the file must hold all of them.
  private async readData(
    key: string,
    info: WavInfo,
    start: number,
    end: number
  ) {
    const { data } = await this.readRange(
      key,
      info.dataOffset + start,
      info.dataOffset + end
    );
    if (data.length !== end - start) {
      throw new MuseTranscribeError(
        'The audio file is shorter than its header says',
        400,
        false
      );
    }
    return data;
  }

  // A ranged GET of the stored object (`end` not included), with the object's whole size from Content-Range.
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

  // Sends one piece, repeating the request on 429 (a few times, backing off), a 5xx or no answer (once).
  private async postPiece(apiKey: string, header: Buffer, data: Buffer) {
    const boundary = `muse${makeId(24)}`;
    const body = museRequestBody(boundary, header, data);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.postOnce(apiKey, boundary, body);
      } catch (err) {
        const retries =
          err instanceof MuseTranscribeError && err.status === 429
            ? RATE_LIMIT_RETRIES
            : SERVER_RETRIES;
        if (
          !(err instanceof MuseTranscribeError) ||
          !err.retryable ||
          attempt >= retries
        ) {
          throw err;
        }
        this._logger.warn(
          `Muse transcribe failed (${err.status || 'no answer'}), retry ${attempt + 1}`
        );
        await timer(RETRY_DELAY_MS * 2 ** attempt);
      }
    }
  }

  // One HTTP call to Muse; its parsed answer for a 2xx, a MuseTranscribeError otherwise.
  private async postOnce(apiKey: string, boundary: string, body: Buffer) {
    let status: number;
    let text: string;
    try {
      const res = await fetch(MUSE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      text = await res.text();
    } catch (cause) {
      throw new MuseTranscribeError(
        `Muse is unreachable: ${cause instanceof Error ? cause.message : cause}`,
        0,
        true
      );
    }
    if (status < 200 || status >= 300) {
      throw museError(status, text);
    }
    try {
      return JSON.parse(text) as MuseAnswer;
    } catch {
      throw new MuseTranscribeError(
        'Muse answered something that is not JSON',
        status,
        false
      );
    }
  }
}
