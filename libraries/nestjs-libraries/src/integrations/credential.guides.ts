// Step-by-step guide article per provider that needs app credentials: how to create the developer
// app and find its keys. The owner fills these in; an empty value hides the guide link.
export const CREDENTIAL_GUIDES: Record<string, string> = {
  x: '',
  linkedin: '',
  'linkedin-page': '',
  reddit: '',
  instagram: '',
  facebook: '',
  'instagram-standalone': '',
  threads: '',
  youtube: '',
  gmb: '',
  tiktok: '',
  'tiktok-business': '',
  pinterest: '',
  dribbble: '',
  discord: '',
  slack: '',
  kick: '',
  twitch: '',
  mastodon: '',
  wrapcast: '',
  telegram: '',
  vk: '',
  whop: '',
  mewe: '',
  tumblr: '',
};

// The guide URL of a provider; '' when it has none (unknown identifier or not filled in yet).
export const credentialGuideUrl = (identifier: string): string =>
  CREDENTIAL_GUIDES[identifier] || '';
