import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';
import {
  ExposeVideoFunction,
  URL,
  Video,
  VideoAbstract,
} from '@gitroom/nestjs-libraries/videos/video.interface';
import Transloadit from 'transloadit';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { Readable } from 'stream';
import { parseBuffer } from 'music-metadata';
import { stringifySync } from 'subtitle';

import { FalService } from '@gitroom/nestjs-libraries/openai/fal.service';
import { IsString } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
// The longest video this type makes, in seconds; longer scripts lose their last slides
const MAX_SECONDS = 30;

const transloadit = new Transloadit({
  authKey: process.env.TRANSLOADIT_AUTH || 'just empty text',
  authSecret: process.env.TRANSLOADIT_SECRET || 'just empty text',
});

// ElevenLabs reports quota and permission problems as 401 with the reason in
// the body, as either { detail: { status, message } } or { detail: 'text' }
async function elevenLabsError(response: Response) {
  const { detail } = await response.json().catch(() => ({ detail: undefined }));
  const reason =
    typeof detail === 'string'
      ? detail
      : detail?.message || detail?.status || response.statusText;
  return `ElevenLabs ${response.status}: ${reason}`;
}

async function getAudioDuration(buffer: Buffer): Promise<number> {
  const metadata = await parseBuffer(buffer, 'audio/mpeg');
  return metadata.format.duration || 0;
}

class ImagesSlidesParams {
  @JSONSchema({
    description: 'Elevenlabs voice id, use a special tool to get it, this is a required filed',
  })
  @IsString()
  voice: string;

  @JSONSchema({
    description: 'Simple string of the prompt, not a json',
  })
  @IsString()
  prompt: string;
}

@Video({
  identifier: 'image-text-slides',
  title: 'Image Text Slides',
  description: 'Generate videos slides from images and text, Don\'t break down the slides, provide only the first slide information',
  placement: 'text-to-image',
  tools: [{ functionName: 'loadVoices', output: 'voice id' }],
  dto: ImagesSlidesParams,
  trial: true,
  available:
    !!process.env.ELEVENSLABS_API_KEY &&
    !!process.env.TRANSLOADIT_AUTH &&
    !!process.env.TRANSLOADIT_SECRET &&
    !!process.env.OPENAI_API_KEY &&
    !!process.env.FAL_KEY,
})
export class ImagesSlides extends VideoAbstract<ImagesSlidesParams> {
  override dto = ImagesSlidesParams;
  private storage = UploadFactory.createStorage();
  constructor(
    private _openaiService: OpenaiService,
    private _falService: FalService
  ) {
    super();
  }

  async process(
    output: 'vertical' | 'horizontal',
    customParams: ImagesSlidesParams
  ): Promise<URL> {
    const list = await this._openaiService.generateSlidesFromText(
      customParams.prompt
    );

    // Slides are voiced in order and only the ones that fit MAX_SECONDS are made
    // (a slide lasts its voice plus a second), so the video is never longer than
    // the length credits were reserved for
    const split: { len: number; url: string }[][] = [];
    let seconds = 0;
    for (const slide of list) {
      const voice = await this.generateVoice(
        slide.voiceText,
        customParams.voice
      );
      if (seconds + voice.len + 1 > MAX_SECONDS) {
        break;
      }
      seconds += voice.len + 1;
      split.push([
        {
          len: 0,
          url: await this._falService.generateImageFromText(
            'ideogram/v2',
            slide.imagePrompt,
            output === 'vertical'
          ),
        },
        voice,
      ]);
    }

    if (!split.length) {
      throw new Error(
        `The text is too long for a video of ${MAX_SECONDS} seconds`
      );
    }

    const srt = stringifySync(
      list
        .slice(0, split.length)
        .reduce((all, current, index) => {
          const start = all.length ? all[all.length - 1].end : 0;
          const end = start + split[index][1].len * 1000 + 1000;
          all.push({
            start: start,
            end: end,
            text: current.voiceText,
          });

          return all;
        }, [] as { start: number; end: number; text: string }[])
        .map((item) => ({
          type: 'cue',
          data: item,
        })),
      { format: 'SRT' }
    );

    console.log(split);

    const { results } = await transloadit.createAssembly({
      uploads: {
        'subtitles.srt': srt,
      },
      waitForCompletion: true,
      timeout: 30 * 60 * 1000,
      params: {
        steps: {
          ...split.reduce((all, current, index) => {
            all[`image${index}`] = {
              robot: '/http/import',
              url: current[0].url,
            };
            all[`audio${index}`] = {
              robot: '/http/import',
              url: current[1].url,
            };
            all[`merge${index}`] = {
              use: [
                {
                  name: `image${index}`,
                  as: 'image',
                },
                {
                  name: `audio${index}`,
                  as: 'audio',
                },
              ],
              robot: '/video/merge',
              duration: current[1].len + 1,
              audio_delay: 0.5,
              preset: 'hls-1080p',
              resize_strategy: 'min_fit',
              loop: true,
            };
            return all;
          }, {} as any),
          concatenated: {
            robot: '/video/concat',
            result: false,
            video_fade_seconds: 0.5,
            use: split.map((p, index) => ({
              name: `merge${index}`,
              as: `video_${index + 1}`,
            })),
          },
          subtitled: {
            robot: '/video/subtitle',
            result: true,
            preset: 'hls-1080p',
            use: {
              bundle_steps: true,
              steps: [
                {
                  name: 'concatenated',
                  as: 'video',
                },
                {
                  name: ':original',
                  as: 'subtitles',
                },
              ],
            },
            position: 'center',
            font_size: 8,
            subtitles_type: 'burned',
          },
        },
      },
    });

    const url: string = results.subtitled[0].url;
    this.renderedSeconds(url, Math.ceil(seconds));
    return url;
  }

  // The longest slideshow: slides beyond it are not made.
  maxSeconds() {
    return MAX_SECONDS;
  }

  // Voices one slide's text with ElevenLabs and stores it; returns its url and length in seconds.
  private async generateVoice(text: string, voiceId: string) {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENSLABS_API_KEY || '',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
        }),
        signal: AbortSignal.timeout(60000),
      }
    );

    if (!response.ok) {
      throw new Error(await elevenLabsError(response));
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    const { path } = await this.storage.uploadFile({
      buffer,
      mimetype: 'audio/mp3',
      size: buffer.length,
      path: '',
      fieldname: '',
      destination: '',
      stream: new Readable(),
      filename: '',
      originalname: '',
      encoding: '',
    });

    return {
      len: await getAudioDuration(buffer),
      url:
        path.indexOf('http') === -1
          ? process.env.FRONTEND_URL +
            '/' +
            process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY +
            path
          : path,
    };
  }

  @ExposeVideoFunction()
  async loadVoices(data: any) {
    const response = await fetch(
      'https://api.elevenlabs.io/v2/voices?page_size=40&category=premade',
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENSLABS_API_KEY || '',
        },
        signal: AbortSignal.timeout(30000),
      }
    );

    if (!response.ok) {
      throw new Error(await elevenLabsError(response));
    }

    const { voices } = await response.json();

    return {
      voices: voices.map((voice: any) => ({
        id: voice.voice_id,
        name: voice.name,
        preview_url: voice.preview_url,
      })),
    };
  }
}
