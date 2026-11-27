// What the shared create-post validation (PostsService.validatePosts) allows in a channel's text and
// title, read the same way by everything that writes text for a channel (auto-publish, AI captions):
// the length of a text as validation counts it, the longest prefix that fits, and the `title` rule of a
// provider's settings class. A provider's own limit is its `maxLength()`; nothing here names a provider.
import { getMetadataStorage } from 'class-validator';
import {
  allProviders,
  EmptySettings,
} from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/all.providers.settings';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { countLength } from '@gitroom/helpers/utils/count.length';

// The `title` setting a channel's settings class declares: whether it has one and its length limit.
export const titleRule = (identifier: string) => {
  const dto = allProviders(EmptySettings).find((p) => p.name === identifier);
  if (!dto) {
    return undefined;
  }
  const rules = getMetadataStorage()
    .getTargetValidationMetadatas(dto.value, '', true, false)
    .filter((m) => m.propertyName === 'title');
  if (!rules.length) {
    return undefined;
  }
  const limit = (name: string) =>
    rules
      .filter((m) => m.name === name && typeof m.constraints?.[0] === 'number')
      .map((m) => m.constraints[0] as number);
  const maxima = limit('maxLength');
  const minima = limit('minLength');
  return {
    max: maxima.length ? Math.min(...maxima) : undefined,
    min: minima.length ? Math.max(...minima) : undefined,
  };
};

// The length of a post's content as the shared create-post validation counts it for a channel
// (stripHtmlValidation + countLength: X weighs characters, Threads counts bytes).
export const postTextLength = (identifier: string, content: string) =>
  countLength(identifier, stripHtmlValidation('normal', content, true));

// The longest prefix of the text (whole characters) for which `fits` is true; the empty string when
// none is. `fits` must stay true for every shorter prefix of a prefix that fits.
export const longestFit = (text: string, fits: (value: string) => boolean) => {
  const chars = Array.from(text);
  // lo always fits (the empty prefix does)
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(chars.slice(0, mid).join(''))) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return chars.slice(0, lo).join('');
};

// The text cut (whole characters, trailing spaces dropped) to at most `max` as the shared create-post
// validation counts a channel's text; the text itself when it fits or there is no limit.
export const fitText = (identifier: string, text: string, max?: number) => {
  const fits = (value: string) => postTextLength(identifier, value) <= max!;
  if (!max || fits(text)) {
    return text;
  }
  return longestFit(text, fits).trimEnd();
};
