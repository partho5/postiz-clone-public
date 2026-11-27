// AI charging: a video type declares the longest video it can make, so credits can be held
// before anything is generated, and reports how long the video it made really is. The slideshow keeps
// only the slides that fit its maximum, so the reservation is a true upper bound.
import { ImagesSlides } from '@gitroom/nestjs-libraries/videos/images-slides/images.slides';
import { Seedance } from '@gitroom/nestjs-libraries/videos/seedance/seedance';

// The providers answer what the test sets: the voice length of each slide, the assembled video.
let mockVoiceSeconds: number[] = [];
const mockAssembly = jest.fn();
jest.mock('file-type', () => ({}));
jest.mock('transloadit', () => ({
  __esModule: true,
  default: class {
    createAssembly(...args: unknown[]) {
      return mockAssembly(...args);
    }
  },
}));
// ESM-only package that ts-jest cannot resolve: a buffer of n bytes is n seconds of audio
jest.mock(
  'music-metadata',
  () => ({
    parseBuffer: async (buffer: Buffer) => ({
      format: { duration: buffer.length },
    }),
  }),
  { virtual: true }
);
jest.mock('subtitle', () => ({ stringifySync: () => 'srt' }));

describe('video types: maximum and rendered length', () => {
  const slides = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      voiceText: `voice ${i}`,
      imagePrompt: `image ${i}`,
    }));

  // A slideshow whose providers are stubbed: slide i is voiced for mockVoiceSeconds[i] seconds.
  const slideshow = (list: unknown[]) => {
    const fal = {
      generateImageFromText: jest.fn(
        async (_m: string, prompt: string) => `https://img.test/${prompt}`
      ),
    };
    const instance = new ImagesSlides(
      { generateSlidesFromText: jest.fn(async () => list) } as any,
      fal as any
    );
    Object.assign(instance as any, {
      storage: {
        uploadFile: jest.fn(async () => ({ path: 'https://audio.test/a.mp3' })),
      },
    });
    let voiced = 0;
    jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        ({
          ok: true,
          arrayBuffer: async () =>
            new Uint8Array(mockVoiceSeconds[voiced++]).buffer,
        } as any)
    );
    return { instance, fal, voiced: () => voiced };
  };

  beforeEach(() => {
    mockAssembly.mockReset();
    mockAssembly.mockResolvedValue({
      results: { subtitled: [{ url: 'https://video.test/out.mp4' }] },
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('seedance makes one fixed 8 second video', () => {
    expect(new Seedance().maxSeconds()).toBe(8);
  });

  it("the slideshow's longest video is 30 seconds", () => {
    expect(slideshow([]).instance.maxSeconds()).toBe(30);
  });

  it('keeps only the slides that fit 30 seconds (each lasts its voice plus a second): later slides are not made or voiced', async () => {
    mockVoiceSeconds = [12, 12, 12, 12];
    const { instance, fal, voiced } = slideshow(slides(4));

    const url = await instance.process('vertical', { voice: 'v', prompt: 'p' });

    expect(fal.generateImageFromText).toHaveBeenCalledTimes(2);
    // the third slide is voiced to learn that it does not fit; the fourth is never voiced
    expect(voiced()).toBe(3);
    const steps = mockAssembly.mock.calls[0][0].params.steps;
    expect(Object.keys(steps).filter((k) => k.startsWith('merge'))).toEqual([
      'merge0',
      'merge1',
    ]);
    expect(url).toBe('https://video.test/out.mp4');
    expect(instance.takeRenderedSeconds(url)).toBe(26);
    expect(instance.takeRenderedSeconds(url)).toBeUndefined();
  });

  it('a script that fits is made whole and reports its length rounded up', async () => {
    mockVoiceSeconds = [5, 6];
    const { instance, fal } = slideshow(slides(2));

    const url = await instance.process('horizontal', {
      voice: 'v',
      prompt: 'p',
    });

    expect(fal.generateImageFromText).toHaveBeenCalledTimes(2);
    expect(instance.takeRenderedSeconds(url)).toBe(13);
  });

  it('a first slide that alone is longer than the maximum makes nothing and fails', async () => {
    mockVoiceSeconds = [40];
    const { instance, fal } = slideshow(slides(2));

    await expect(
      instance.process('vertical', { voice: 'v', prompt: 'p' })
    ).rejects.toThrow('too long for a video of 30 seconds');

    expect(fal.generateImageFromText).not.toHaveBeenCalled();
    expect(mockAssembly).not.toHaveBeenCalled();
  });
});
