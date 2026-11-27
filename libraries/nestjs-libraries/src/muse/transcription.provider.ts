// The transcriber behind AI captions (ai.video-captions): turns the speech audio of a recording, a file already
// in storage, into text with timings. One class implements it (Muse today, muse.transcription.service.ts), so
// the caption job never names a provider.
import { HttpException } from '@nestjs/common';

// One timed word or speech event: times in milliseconds from the start of the recording.
export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
  type: 'word' | 'spacing' | 'audio_event';
  speaker?: string;
}

// One timed piece of the speech (a turn): times in milliseconds from the start of the recording.
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
  words?: TranscriptWord[];
}

export interface Transcription {
  text: string;
  // The spoken language when the transcriber reports it (Muse does not: it is left unset)
  language?: string;
  segments: TranscriptSegment[];
  words?: TranscriptWord[];
  // The length of the audio in seconds, from its WAV header
  seconds: number;
}

export interface TranscriptionProvider {
  // The provider's model id, as the AI edit's usage ledger names it (a provider that does not say is not ledgered)
  readonly model?: string;
  // Whether the provider's key is set; false means every caption job answers 503
  isConfigured(): boolean;
  // The length in seconds of the audio stored under `key`, read from its header alone: what the caption job charges
  audioSeconds(key: string): Promise<number>;
  // Transcribes the audio object stored under `key`; AiCaptionsNotConfigured when the key is not set
  transcribe(key: string): Promise<Transcription>;
}

// The transcriber's key is not set, so AI captions are off for this server. Answers 503
// AI_CAPTIONS_NOT_CONFIGURED over HTTP; never a start-up error.
export class AiCaptionsNotConfigured extends HttpException {
  constructor() {
    super(
      {
        statusCode: 503,
        code: 'AI_CAPTIONS_NOT_CONFIGURED',
        message: 'AI captions are not configured on this server.',
      },
      503
    );
    this.name = 'AiCaptionsNotConfigured';
  }
}
