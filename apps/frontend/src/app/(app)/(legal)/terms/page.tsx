// Legal pages: the public Terms of Service page.
import type { Metadata } from 'next';
import {
  PRODUCT_CONTACT_EMAIL,
  PRODUCT_NAME,
  PRODUCT_OPERATOR,
} from '@gitroom/helpers/brand/brand.identity';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Terms of Service`,
  description: '',
};

// Renders the terms: who runs the service, how to reach them, the credit rules and the no-refund rule.
export default function TermsPage() {
  return (
    <>
      <h1 className="text-[28px] font-semibold">Terms of Service</h1>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">Who runs the service</h2>
        <p>
          {PRODUCT_NAME} is run by {PRODUCT_OPERATOR}. You can reach the operator
          at{' '}
          <a className="underline" href={`mailto:${PRODUCT_CONTACT_EMAIL}`}>
            {PRODUCT_CONTACT_EMAIL}
          </a>
          .
        </p>
      </section>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">The service</h2>
        <p>
          {PRODUCT_NAME} lets you connect social media channels, schedule and
          publish posts to them, organise channels into brands under one
          account, and use AI tools for text, images and video. By creating an
          account or using the service you agree to these terms.
        </p>
      </section>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">Credits</h2>
        <p>
          Publishing a post and using an AI tool cost credits. The credit cost of
          an action is shown in the app before you confirm it. If you do not have
          enough credits, the action is refused and nothing is charged.
        </p>
        <ul className="list-disc ps-[24px] flex flex-col gap-[4px]">
          <li>Credits bought as a top-up never expire.</li>
          <li>Credits that come with a plan reset at each billing period.</li>
          <li>Free credits reset every month.</li>
          <li>
            Credits reserved for a scheduled post are returned when the post is
            deleted, when its channel is removed, or when it cannot be published.
          </li>
        </ul>
      </section>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">Payments and refunds</h2>
        <p>
          Payments are taken by PayPal; subscriptions bought in a mobile app are
          handled by the app store. There are no cash refunds. Credits that
          were already spent on a published post or a generated result are not
          returned.
        </p>
      </section>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">Your content and channels</h2>
        <p>
          You are responsible for the content you publish and for following the
          rules of each social platform you connect. You keep ownership of your
          content. Posts are published to your channels with the access you grant
          when you connect them, and you can disconnect a channel at any time.
        </p>
      </section>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">Ending your account</h2>
        <p>
          You can delete your account at any time; see the data deletion page.
          The operator may suspend an account that breaks these terms or the
          rules of a connected platform.
        </p>
      </section>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">Contact</h2>
        <p>
          Questions about these terms:{' '}
          <a className="underline" href={`mailto:${PRODUCT_CONTACT_EMAIL}`}>
            {PRODUCT_CONTACT_EMAIL}
          </a>
          .
        </p>
      </section>
    </>
  );
}
