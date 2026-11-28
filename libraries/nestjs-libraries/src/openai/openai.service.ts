import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { shuffle } from 'lodash';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { ZodType } from 'zod/v4';
import {
  EditDirection,
  EditDirectionSchema,
  EditIconPicks,
  EditLlmClient,
  EditLlmEffort,
  EditLlmMessage,
  EditTextsDraft,
  EditTextsSchema,
  IconPicksSchema,
} from '@gitroom/nestjs-libraries/ai-video-edit/edit.llm';
import { LlmUsage, jsonChars, llmUsage } from '@gitroom/nestjs-libraries/ai-video-edit/llm.usage';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'sk-proj-',
});

const PicturePrompt = z.object({
  prompt: z.string(),
});

const VoicePrompt = z.object({
  voice: z.string(),
});

const ClipsPrompt = z.object({
  clips: z.array(
    z.object({
      from: z.number().describe('Number of the first line of the clip'),
      to: z.number().describe('Number of the last line of the clip'),
      title: z.string().describe('Short title of the clip'),
      content: z
        .string()
        .describe('Social media post to publish the clip with, no hashtags'),
    })
  ),
});

const CaptionPrompt = z.object({
  title: z
    .string()
    .describe('Title of the post, an empty string when there is none'),
  text: z.string().describe('The caption itself, without hashtags'),
  hashtags: z
    .array(z.string())
    .describe('Hashtags without the # sign, no spaces, no repeats'),
});

// One message of the conversation that writes a caption.
export type CaptionMessage = { role: 'user' | 'assistant'; content: string };

// What the model wrote for a caption; `hashtags` come without the # sign.
export type CaptionDraft = z.infer<typeof CaptionPrompt>;

@Injectable()
export class OpenaiService implements EditLlmClient {
  // The model answers with line numbers and not times, so a clip can only
  // start and end where the transcript really has a boundary
  async pickClips(
    title: string,
    language: string,
    segments: { start: number; end: number; text: string }[],
    maxClips: number
  ) {
    const { clips } = (
      await openai.chat.completions.parse(
        {
          model: 'gpt-4.1',
          messages: [
            {
              role: 'system',
              content: `You are an assistant that takes the transcript of a video and picks the parts that will work best as short vertical clips for social media.
Every line of the transcript is "number [start seconds - end seconds] text".
Pick up to ${maxClips} clips, best first. A clip is a range of consecutive lines that starts with a hook, makes one complete point and is understandable without the rest of the video.
The length of a clip is the end of its last line minus the start of its first line: it must be between 20 and 90 seconds, never longer, so check the numbers before answering.
Clips must not overlap. Write the title and the post in this language, whatever the language of these instructions: ${language}.`,
            },
            {
              role: 'user',
              content: `title: ${title}\n\n${segments
                .map(
                  (p, index) =>
                    `${index} [${p.start.toFixed(1)} - ${p.end.toFixed(1)}] ${
                      p.text
                    }`
                )
                .join('\n')}`,
            },
          ],
          response_format: zodResponseFormat(ClipsPrompt, 'clipsPrompt'),
        },
        // shorter than the activity: an attempt that was given up on must not
        // still be running, and storing clips, when its retry gets there
        { timeout: 8 * 60 * 1000, maxRetries: 0 }
      )
    ).choices[0].message.parsed || { clips: [] };

    return clips;
  }

  // Writes a caption from a finished prompt on the model and reasoning effort the Prompt Book names
  // (the effort is sent only to a reasoning model, the others reject it); null when the model refuses.
  // A later message may ask for a shorter version of an earlier answer.
  async writeCaption(
    model: string,
    reasoningEffort: 'minimal' | 'low' | 'medium' | 'high',
    messages: CaptionMessage[]
  ): Promise<CaptionDraft | null> {
    return (
      (
        await openai.chat.completions.parse(
          {
            model,
            ...(/^(gpt-5|o\d)/.test(model)
              ? { reasoning_effort: reasoningEffort }
              : {}),
            messages,
            response_format: zodResponseFormat(CaptionPrompt, 'captionPrompt'),
          },
          // short enough for the activity's attempts to fit its timeout
          { timeout: 60 * 1000, maxRetries: 1 }
        )
      ).choices[0].message.parsed || null
    );
  }

  // The decision call of an AI edit (the writer's texts, the icon picker's picks) on the given model and reasoning effort
  // (sent only to a reasoning model, the others reject it): the schema's answer, or null when the model refuses. `usage`,
  // when given, gets what the call used, also when it fails.
  private async completeEdit<T>(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    schema: ZodType<T>,
    name: string,
    usage?: LlmUsage[]
  ): Promise<T | null> {
    const startedAt = Date.now();
    const inputChars = jsonChars(messages);
    try {
      const completion = await openai.chat.completions.parse(
        {
          model,
          ...(/^(gpt-5|o\d)/.test(model)
            ? { reasoning_effort: effort }
            : {}),
          messages,
          response_format: zodResponseFormat(schema, name),
        },
        // short enough for the activity's attempts to fit its timeout
        { timeout: 60 * 1000, maxRetries: 1 }
      );
      const parsed = completion.choices[0].message.parsed || null;
      usage?.push(
        llmUsage({ model: completion.model || model, reported: completion.usage, inputChars, outputChars: jsonChars(parsed), startedAt, ok: true })
      );
      return parsed;
    } catch (err) {
      usage?.push(llmUsage({ model, inputChars, startedAt, ok: false }));
      throw err;
    }
  }

  // The writer's texts of an AI edit (ai.video-editing, Heavy).
  writeEditTexts(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditTextsDraft | null> {
    return this.completeEdit(model, effort, messages, EditTextsSchema, 'editTextsPrompt', usage);
  }

  // The icon picker's picks of an AI edit (ai.video-editing, one call for all the slots).
  pickEditIcons(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditIconPicks | null> {
    return this.completeEdit(model, effort, messages, IconPicksSchema, 'iconPicksPrompt', usage);
  }

  // The director's labels of an AI edit (ai.video-editing: the style of the video and a label per sentence).
  directEdit(
    model: string,
    effort: EditLlmEffort,
    messages: EditLlmMessage[],
    usage?: LlmUsage[]
  ): Promise<EditDirection | null> {
    return this.completeEdit(model, effort, messages, EditDirectionSchema, 'editDirectionPrompt', usage);
  }

  async generateImage(prompt: string, isVertical = false) {
    // gpt-image models always return base64 (b64_json) and do not accept the
    // `response_format` parameter, unlike the deprecated dall-e-3.
    const generate = (
      await openai.images.generate({
        prompt,
        model: 'chatgpt-image-latest',
        size: isVertical ? '1024x1536' : '1024x1024',
      })
    ).data[0];

    return generate.b64_json;
  }

  async generatePromptForPicture(prompt: string) {
    return (
      (
        await openai.chat.completions.parse({
          model: 'gpt-4.1',
          messages: [
            {
              role: 'system',
              content: `You are an assistant that take a description and style and generate a prompt that will be used later to generate images, make it a very long and descriptive explanation, and write a lot of things for the renderer like, if it${"'"}s realistic describe the camera`,
            },
            {
              role: 'user',
              content: `prompt: ${prompt}`,
            },
          ],
          response_format: zodResponseFormat(PicturePrompt, 'picturePrompt'),
        })
      ).choices[0].message.parsed?.prompt || ''
    );
  }

  async generateVoiceFromText(prompt: string) {
    return (
      (
        await openai.chat.completions.parse({
          model: 'gpt-4.1',
          messages: [
            {
              role: 'system',
              content: `You are an assistant that takes a social media post and convert it to a normal human voice, to be later added to a character, when a person talk they don\'t use "-", and sometimes they add pause with "..." to make it sounds more natural, make sure you use a lot of pauses and make it sound like a real person`,
            },
            {
              role: 'user',
              content: `prompt: ${prompt}`,
            },
          ],
          response_format: zodResponseFormat(VoicePrompt, 'voice'),
        })
      ).choices[0].message.parsed?.voice || ''
    );
  }

  async generatePosts(content: string) {
    const posts = (
      await Promise.all([
        openai.chat.completions.create({
          messages: [
            {
              role: 'assistant',
              content:
                'Generate a Twitter post from the content without emojis in the following JSON format: { "post": string } put it in an array with one element',
            },
            {
              role: 'user',
              content: content!,
            },
          ],
          n: 5,
          temperature: 1,
          model: 'gpt-4.1',
        }),
        openai.chat.completions.create({
          messages: [
            {
              role: 'assistant',
              content:
                'Generate a thread for social media in the following JSON format: Array<{ "post": string }> without emojis',
            },
            {
              role: 'user',
              content: content!,
            },
          ],
          n: 5,
          temperature: 1,
          model: 'gpt-4.1',
        }),
      ])
    ).flatMap((p) => p.choices);

    return shuffle(
      posts.map((choice) => {
        const { content } = choice.message;
        const start = content?.indexOf('[')!;
        const end = content?.lastIndexOf(']')!;
        try {
          return JSON.parse(
            '[' +
              content
                ?.slice(start + 1, end)
                .replace(/\n/g, ' ')
                .replace(/ {2,}/g, ' ') +
              ']'
          );
        } catch (e) {
          return [];
        }
      })
    );
  }
  async extractWebsiteText(content: string) {
    const websiteContent = await openai.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content:
            'You take a full website text, and extract only the article content',
        },
        {
          role: 'user',
          content,
        },
      ],
      model: 'gpt-4.1',
    });

    const { content: articleContent } = websiteContent.choices[0].message;

    return this.generatePosts(articleContent!);
  }

  async separatePosts(content: string, len: number) {
    const SeparatePostsPrompt = z.object({
      posts: z.array(z.string()),
    });

    const SeparatePostPrompt = z.object({
      post: z.string().max(len),
    });

    const posts =
      (
        await openai.chat.completions.parse({
          model: 'gpt-4.1',
          messages: [
            {
              role: 'system',
              content: `You are an assistant that take a social media post and break it to a thread, each post must be minimum ${
                len - 10
              } and maximum ${len} characters, keeping the exact wording and break lines, however make sure you split posts based on context`,
            },
            {
              role: 'user',
              content: content,
            },
          ],
          response_format: zodResponseFormat(
            SeparatePostsPrompt,
            'separatePosts'
          ),
        })
      ).choices[0].message.parsed?.posts || [];

    return {
      posts: await Promise.all(
        posts.map(async (post: any) => {
          if (post.length <= len) {
            return post;
          }

          let retries = 4;
          while (retries) {
            try {
              return (
                (
                  await openai.chat.completions.parse({
                    model: 'gpt-4.1',
                    messages: [
                      {
                        role: 'system',
                        content: `You are an assistant that take a social media post and shrink it to be maximum ${len} characters, keeping the exact wording and break lines`,
                      },
                      {
                        role: 'user',
                        content: post,
                      },
                    ],
                    response_format: zodResponseFormat(
                      SeparatePostPrompt,
                      'separatePost'
                    ),
                  })
                ).choices[0].message.parsed?.post || ''
              );
            } catch (e) {
              retries--;
            }
          }

          return post;
        })
      ),
    };
  }

  async generateSlidesFromText(text: string) {
    for (let i = 0; i < 3; i++) {
      try {
        const message = `You are an assistant that takes a text and break it into slides, each slide should have an image prompt and voice text to be later used to generate a video and voice, image prompt should capture the essence of the slide and also have a back dark gradient on top, image prompt should not contain text in the picture, generate between 3-5 slides maximum`;
        const parse =
          (
            await openai.chat.completions.parse({
              model: 'gpt-4.1',
              messages: [
                {
                  role: 'system',
                  content: message,
                },
                {
                  role: 'user',
                  content: text,
                },
              ],
              response_format: zodResponseFormat(
                z.object({
                  slides: z
                    .array(
                      z.object({
                        imagePrompt: z.string(),
                        voiceText: z.string(),
                      })
                    )
                    .describe('an array of slides'),
                }),
                'slides'
              ),
            })
          ).choices[0].message.parsed?.slides || [];

        return parse;
      } catch (err) {
        console.log(err);
      }
    }

    return [];
  }
}
