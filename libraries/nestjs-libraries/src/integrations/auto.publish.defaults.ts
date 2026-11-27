// Mobile auto-publish without a Set (automatic mode): the settings each provider's post gets when
// nobody picks them. Only providers that publish one video with no human choice are listed; each
// entry fills every required field of the provider's settings class
// (dtos/posts/providers-settings/*). A `title` setting is not listed: the recording's name fills it
// (AutoPublishService.settingsWithTitle). Providers whose post needs a choice (Pinterest board,
// Reddit/Lemmy community, Discord/Slack/Telegram channel, article sites, ...) or that take no
// video (GMB, Nostr, MeWe, Dribbble, Kick, Twitch, ...) are left out: they are never auto-published
// (the ones that need no choice can get a text post instead, see TEXT_POST_DEFAULTS).
// The key order is the display order of the 'video' group.
export const AUTO_DEFAULTS: Record<string, Record<string, unknown>> = {
  youtube: { type: 'public', selfDeclaredMadeForKids: 'no' },
  tiktok: {
    privacy_level: 'PUBLIC_TO_EVERYONE',
    duet: false,
    stitch: false,
    comment: true,
    autoAddMusic: 'no',
    brand_content_toggle: false,
    brand_organic_toggle: false,
    video_made_with_ai: false,
    content_posting_method: 'DIRECT_POST',
  },
  // A single video with post_type 'post' is published as a Reel.
  instagram: { post_type: 'post' },
  'instagram-standalone': { post_type: 'post' },
  facebook: { post_type: 'post' },
  x: { post_type: 'post', who_can_reply_post: 'everyone' },
  linkedin: { post_as_images_carousel: false },
  'linkedin-page': { post_as_images_carousel: false },
  threads: {},
  'tiktok-business': {
    privacy_level: 'PUBLIC_TO_EVERYONE',
    duet: false,
    stitch: false,
    comment: true,
    autoAddMusic: 'no',
    brand_content_toggle: false,
    brand_organic_toggle: false,
    video_made_with_ai: false,
    content_posting_method: 'DIRECT_POST',
  },
  bluesky: {},
  mastodon: {},
  tumblr: {},
  vk: {},
};

// The providers of the 'video' group, in display order.
export const VIDEO_PLATFORMS: string[] = Object.keys(AUTO_DEFAULTS);

// Whether auto-publish posts to this provider's channels.
export const autoPublishSupported = (identifier: string): boolean =>
  Object.prototype.hasOwnProperty.call(AUTO_DEFAULTS, identifier);

// The group a provider is shown in: 'video' for the auto-published ones, else 'other'.
export const platformGroup = (identifier: string): 'video' | 'other' =>
  autoPublishSupported(identifier) ? 'video' : 'other';

// A copy of the automatic-mode settings of a provider; {} for one that is not auto-published.
export const autoPublishDefaults = (identifier: string) => ({
  ...(AUTO_DEFAULTS[identifier] || {}),
});

// AI captions (ai.video-captions): the settings of the text post a provider gets from a recording in
// automatic mode, for the channels the workspace switched on (AutoPublishPreset.textIntegrations).
// Only a provider that takes no video (`acceptsVideo = false`) and needs no human choice is listed;
// each entry fills every required field of the provider's settings class.
export const TEXT_POST_DEFAULTS: Record<string, Record<string, unknown>> = {
  gmb: { topicType: 'STANDARD' },
  nostr: {},
};

// Whether a recording can be posted as text to this provider's channels.
export const textPostSupported = (identifier: string): boolean =>
  Object.prototype.hasOwnProperty.call(TEXT_POST_DEFAULTS, identifier);

// A copy of the text-post settings of a provider; {} for one that is not listed.
export const textPostDefaults = (identifier: string) => ({
  ...(TEXT_POST_DEFAULTS[identifier] || {}),
});
