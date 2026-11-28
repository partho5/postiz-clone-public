// ai.video-editing (S2): the `capabilities` of the engine request. `text_motions` and `text_features` are optional lists of
// plain names (absent means the legacy set only); an over-long list, an over-long name or a name with other characters is
// refused. Runs the body through the class-validator the route uses; needs no database and no Nest.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AI_EDIT_MAX_CHAPTERS,
  AI_EDIT_MAX_TEXT_CAPABILITIES,
  AiEditCapabilitiesDto,
  AiVideoEditCreateDto,
} from '@gitroom/nestjs-libraries/dtos/ai-video-edits/ai.video.edit.create.dto';
import {
  GOLDEN_FIXTURES,
  goldenRequest,
} from '@gitroom/nestjs-libraries/ai-video-edit/core/fixtures/edit.golden.fixtures';

const base = { effects: ['x_pop'], text_styles: ['sticker'] };
const check = (caps: Record<string, unknown>) =>
  validate(plainToInstance(AiEditCapabilitiesDto, caps), { whitelist: true, forbidNonWhitelisted: true });

describe('ai.video-editing: request capabilities', () => {
  it('accepts the legacy request, with neither list', async () => {
    expect(await check(base)).toEqual([]);
  });

  it('accepts both lists, and an empty list', async () => {
    expect(await check({ ...base, text_motions: ['pop', 'slide_left', 'typewriter'], text_features: ['box_gradient'] })).toEqual([]);
    expect(await check({ ...base, text_motions: [], text_features: [] })).toEqual([]);
  });

  it('keeps both lists on the instance, so the planner can read them', () => {
    const dto = plainToInstance(AiEditCapabilitiesDto, { ...base, text_motions: ['fade'], text_features: ['glow'] });
    expect(dto.text_motions).toEqual(['fade']);
    expect(dto.text_features).toEqual(['glow']);
  });

  it('accepts the whole create body of a golden request with the lists added', async () => {
    const request = goldenRequest(GOLDEN_FIXTURES[0]);
    const body = {
      sessionId: '2f1d1c9e-6f0a-4c55-9a39-0d3c6f1f8a11',
      level: 'basic',
      aiCaptionId: 'caption-1',
      request: { ...request, capabilities: { ...request.capabilities, text_motions: ['pop'], text_features: ['text_shadow'] } },
    };
    expect(await validate(plainToInstance(AiVideoEditCreateDto, body), { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
  });

  it.each(['text_motions', 'text_features'])('accepts %s at the cap and refuses one name more', async (key) => {
    const list = (n: number) => Array.from({ length: n }, (_v, i) => `name_${i}`);
    expect(await check({ ...base, [key]: list(AI_EDIT_MAX_TEXT_CAPABILITIES) })).toEqual([]);
    expect((await check({ ...base, [key]: list(AI_EDIT_MAX_TEXT_CAPABILITIES + 1) })).length).toBeGreaterThan(0);
  });

  it.each(['text_motions', 'text_features'])('refuses a %s that is not a list of plain names', async (key) => {
    expect((await check({ ...base, [key]: 'pop' })).length).toBeGreaterThan(0);
    expect((await check({ ...base, [key]: [1] })).length).toBeGreaterThan(0);
    expect((await check({ ...base, [key]: ['a'.repeat(65)] })).length).toBeGreaterThan(0);
    expect((await check({ ...base, [key]: [''] })).length).toBeGreaterThan(0);
    expect((await check({ ...base, [key]: ['Slide Left'] })).length).toBeGreaterThan(0);
    expect((await check({ ...base, [key]: ['pop; drop table'] })).length).toBeGreaterThan(0);
  });
});

// TS2: the optional `chapters` of the engine request. Synthetic titles and notes only.
describe('ai.video-editing: request chapters', () => {
  const request = goldenRequest(GOLDEN_FIXTURES[0]);
  const chapter = { start_ms: 4000, kind: 'text', title: 'Slide one', note: 'A short note' };
  const body = (chapters?: unknown) => ({
    sessionId: '2f1d1c9e-6f0a-4c55-9a39-0d3c6f1f8a11',
    level: 'basic',
    aiCaptionId: 'caption-1',
    request: { ...request, ...(chapters === undefined ? {} : { chapters }) },
  });
  const check = (chapters?: unknown) =>
    validate(plainToInstance(AiVideoEditCreateDto, body(chapters)), { whitelist: true, forbidNonWhitelisted: true });

  it('accepts a request without chapters (an older phone) and with an empty list', async () => {
    expect(await check()).toEqual([]);
    expect(await check([])).toEqual([]);
  });

  it('accepts chapters with and without title, note and region', async () => {
    expect(
      await check([
        chapter,
        { start_ms: 0, kind: 'image' },
        { start_ms: 9000, kind: 'other', region: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 } },
      ])
    ).toEqual([]);
  });

  it('keeps the chapters, with their region, on the instance', () => {
    const dto = plainToInstance(AiVideoEditCreateDto, body([{ ...chapter, region: { x: 0, y: 0.1, w: 1, h: 0.4 } }]));
    expect(dto.request.chapters).toHaveLength(1);
    expect(dto.request.chapters![0].region).toEqual({ x: 0, y: 0.1, w: 1, h: 0.4 });
  });

  it('refuses a title of 121 characters and accepts 120', async () => {
    expect(await check([{ ...chapter, title: 'a'.repeat(120) }])).toEqual([]);
    expect((await check([{ ...chapter, title: 'a'.repeat(121) }])).length).toBeGreaterThan(0);
  });

  it('refuses a note of 601 characters and accepts 600', async () => {
    expect(await check([{ ...chapter, note: 'a'.repeat(600) }])).toEqual([]);
    expect((await check([{ ...chapter, note: 'a'.repeat(601) }])).length).toBeGreaterThan(0);
  });

  it('refuses a chapter with a negative or fractional start, or an unknown kind', async () => {
    expect((await check([{ ...chapter, start_ms: -1 }])).length).toBeGreaterThan(0);
    expect((await check([{ ...chapter, start_ms: 1.5 }])).length).toBeGreaterThan(0);
    expect((await check([{ ...chapter, kind: 'video' }])).length).toBeGreaterThan(0);
  });

  it('refuses a region outside the master frame and chapters that are not a list', async () => {
    expect((await check([{ ...chapter, region: { x: 0, y: 0, w: 1.2, h: 0.5 } }])).length).toBeGreaterThan(0);
    expect((await check([{ ...chapter, region: { x: 0, y: 0, w: 0.5 } }])).length).toBeGreaterThan(0);
    expect((await check({ start_ms: 0, kind: 'text' })).length).toBeGreaterThan(0);
  });

  it('accepts chapters at the cap and refuses one more', async () => {
    const list = (n: number) => Array.from({ length: n }, (_v, i) => ({ start_ms: i * 1000, kind: 'other' }));
    expect(await check(list(AI_EDIT_MAX_CHAPTERS))).toEqual([]);
    expect((await check(list(AI_EDIT_MAX_CHAPTERS + 1))).length).toBeGreaterThan(0);
  });
});
