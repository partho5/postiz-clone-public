// Legal pages: the public Privacy Policy page.
import type { Metadata } from 'next';
import {
  PRODUCT_CONTACT_EMAIL,
  PRODUCT_NAME,
  PRODUCT_OPERATOR,
} from '@gitroom/helpers/brand/brand.identity';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Privacy Policy`,
  description: '',
};

// Renders the privacy policy: what is kept, who receives data, and how to reach the operator.
export default function PrivacyPage() {
  return (
    <>
      <h1 className="text-[28px] font-semibold">Privacy Policy</h1>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">Who is responsible</h2>
        <p>
          {PRODUCT_NAME} is run by {PRODUCT_OPERATOR}, who decides how your data
          is used. Contact:{' '}
          <a className="underline" href={`mailto:${PRODUCT_CONTACT_EMAIL}`}>
            {PRODUCT_CONTACT_EMAIL}
          </a>
          .
        </p>
      </section>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">What is kept about you</h2>
        <ul className="list-disc ps-[24px] flex flex-col gap-[4px]">
          <li>
            Your email address, name and profile text, your picture, and the
            sign-in sessions of your devices.
          </li>
          <li>
            The IP address and browser string recorded when you sign up; they
            are also sent to Meta with the sign-up event when that analytics is
            enabled.
          </li>
          <li>
            Your brands, scheduled and published posts, and the media you upload.
          </li>
          <li>
            For each channel you connect: its name, picture and the access token
            the platform gave us, which is used only to publish and read
            analytics for you.
          </li>
          <li>
            Your credit balance and a ledger of every credit granted, reserved and
            spent, and your payment records.
          </li>
          <li>
            The prompts you send to the AI tools and the results they return.
          </li>
          <li>
            When you use AI captions, the transcript of the speech in a
            recording, until you delete it in the app.
          </li>
        </ul>
      </section>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">Who receives your data</h2>
        <p>
          Data is shared only with the services below, and only as far as the
          feature you use needs. A service is used only when it is set up for
          this deployment.
        </p>
        <ul className="list-disc ps-[24px] flex flex-col gap-[4px]">
          <li>
            Social platforms you connect: the posts, media and channel requests
            you make are sent to the platform of each channel.
          </li>
          <li>
            Payments: PayPal receives your plan and top-up payments. In a mobile
            app, in-app subscriptions are handled by the Apple App Store or
            Google Play and reported to us through RevenueCat.
          </li>
          <li>
            Sign-in: if you sign in with Google, GitHub, Apple, Farcaster
            (through Neynar), a crypto wallet or the operator&apos;s own OpenID
            provider, that provider receives your sign-in request.
          </li>
          <li>
            Email: Mailgun, Resend or the operator&apos;s own SMTP server
            delivers sign-in codes and notifications to your email address.
          </li>
          <li>
            File storage: uploaded media is stored on this service&apos;s server
            or in Cloudflare R2.
          </li>
          <li>
            AI providers: OpenAI, fal, ElevenLabs, Evolink, Deepgram and Tavily
            receive the prompts, media or search terms you send to a text,
            image, voice, video, transcription or research tool. For AI
            captions, Meta Muse Transcribe receives the voice audio of your
            recording to turn it into text, and the stored audio is deleted once
            it is transcribed; OpenAI receives the transcript to write the
            captions. The transcript is kept until you delete it. For the
            content plan, the business details you enter there are sent to
            Meta (Meta Muse) to write the plan, and Meta may use them to
            improve its models.
          </li>
          <li>
            Design editor: Polotno provides the in-app design and media editor
            and receives the licence check and the stock photo and video
            searches you make in it.
          </li>
          <li>
            Assistant: CopilotKit receives product usage telemetry from the
            in-app assistant component, which does not include your posts.
          </li>
          <li>
            Webhooks: if you configure a webhook, the post data is sent to the
            address you saved.
          </li>
          <li>
            Media tools you connect yourself: HeyGen and ReelFarm receive the
            text and settings you send to them with your own API key.
          </li>
          <li>
            Agent Media: if you open Agent Media from the menu, it receives the
            id and name of your workspace.
          </li>
          <li>
            Media processing: RunPod and Transloadit process video and media you
            upload or generate.
          </li>
          <li>
            Short links: Dub, Kutt, LinkDrip or Short.io shortens the links you
            choose to shorten.
          </li>
          <li>
            Newsletter, when set up: Beehiiv or Listmonk receives your email
            address when you sign in with a connected provider account.
          </li>
          <li>Error tracking: Sentry receives error reports from the app.</li>
          <li>
            Analytics, when enabled: PostHog, Google Tag Manager, Meta Pixel and
            DataFast receive usage events from your browser, and Meta and
            DataFast also receive sign-up events from our server.
          </li>
          <li>
            Abuse protection and support, when enabled: Google reCAPTCHA
            protects the comment form on shared post previews, and Chatbase
            provides the support chat.
          </li>
        </ul>
        <p>We do not sell your data.</p>
      </section>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">Your choices</h2>
        <p>
          You can disconnect a channel, delete a post, or delete your whole
          account at any time. See the data deletion page for how, and what is
          removed.
        </p>
      </section>
    </>
  );
}
