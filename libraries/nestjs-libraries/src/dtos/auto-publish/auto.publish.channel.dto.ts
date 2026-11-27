// Zero-friction auto-publish (B5, api.platforms): the body of PUT /public/v1/auto-publish/channels/:id and
// of PUT /public/v1/auto-publish/text-channels/:id (ai.video-captions).
import { IsBoolean, IsDefined } from 'class-validator';

// Whether auto-publish posts to the channel (false switches it off in both modes); on the text-channels route,
// whether the channel gets a text post from a recording.
export class AutoPublishChannelDto {
  @IsDefined()
  @IsBoolean()
  enabled: boolean;
}
