// Legal pages: the public data-deletion instructions page.
import type { Metadata } from 'next';
import {
  PRODUCT_CONTACT_EMAIL,
  PRODUCT_NAME,
  PRODUCT_OPERATOR,
} from '@gitroom/helpers/brand/brand.identity';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} Data deletion`,
  description: '',
};

// Renders how to delete an account and its data, in the app and by email, and what is removed.
export default function DataDeletionPage() {
  return (
    <>
      <h1 className="text-[28px] font-semibold">Data deletion</h1>
      <p>
        {PRODUCT_NAME} is run by {PRODUCT_OPERATOR}. This page explains how to
        have your account and data deleted.
      </p>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">Delete your account in the app</h2>
        <ol className="list-decimal ps-[24px] flex flex-col gap-[4px]">
          <li>Sign in to {PRODUCT_NAME}.</li>
          <li>Open Settings and then the Global Settings tab.</li>
          <li>Choose Delete Account and confirm.</li>
        </ol>
      </section>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">Delete your data by email</h2>
        <p>
          If you cannot sign in, write to{' '}
          <a className="underline" href={`mailto:${PRODUCT_CONTACT_EMAIL}`}>
            {PRODUCT_CONTACT_EMAIL}
          </a>{' '}
          from the email address of the account and ask for it to be deleted. The
          operator will confirm by reply once it is done. You can also ask in the
          same email for the uploaded media and credit records, which the
          in-app action does not remove.
        </p>
      </section>
      <section className="flex flex-col gap-[8px]">
        <h2 className="text-[20px] font-semibold">What happens</h2>
        <ul className="list-disc ps-[24px] flex flex-col gap-[4px]">
          <li>
            PayPal subscriptions of the workspaces you own are cancelled before
            anything else. A subscription bought in a mobile app is not
            cancelled by this; cancel it in the app store.
          </li>
          <li>
            Your sign-in is ended. Your email address, name, provider id and
            profile text are replaced by a hash, and your picture, IP address and
            browser string are removed.
          </li>
          <li>
            The workspaces you own are marked deleted and their posts are marked
            deleted and no longer shown or published; the post content, uploaded
            media and credit records are kept and are not removed by this action.
          </li>
          <li>
            The names, identifiers and access tokens of your connected channels
            are replaced by a hash, so the access can no longer be used, and
            their pictures are removed.
          </li>
          <li>
            If you own a workspace that has other members, remove them first;
            the deletion is refused until you do.
          </li>
        </ul>
        <p>
          Posts already published on a social platform stay there; delete them on
          that platform. You can also remove {PRODUCT_NAME} from the connected
          apps of each platform. Payment records may be kept as far as the law
          requires.
        </p>
      </section>
    </>
  );
}
