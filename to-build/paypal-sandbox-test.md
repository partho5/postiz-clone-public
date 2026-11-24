# PayPal sandbox test (T3)

## 1. Get the sandbox values (developer.paypal.com, log in with your normal PayPal account)
1. Apps & Credentials, switch the toggle at the top to **Sandbox**.
2. Open your app (or **Create App**, type Merchant). Copy **Client ID** and **Secret**.
3. In that app, scroll to **Sandbox Webhooks** > **Add Webhook**.
   URL: `<NEXT_PUBLIC_BACKEND_URL>/payment/paypal` (production: `https://<DOMAIN>/api/payment/paypal`).
   It must be a public https URL; for a laptop use a tunnel, or any https URL if you only test top-ups.
   Events: **All events**. Save, copy the **Webhook ID**.
4. Testing Tools > **Sandbox Accounts**: note the **Personal** account's email; "..." > View/Edit
   account shows its password. That is the buyer you pay with.

## 2. Env lines (backend `.env`, or `deploy/.env` on the server)
```
PAYPAL_MODE=sandbox
PAYPAL_API_BASE=
PAYPAL_CLIENT_ID=<sandbox client id>
PAYPAL_CLIENT_SECRET=<sandbox secret>
PAYPAL_WEBHOOK_ID=<sandbox webhook id>
FRONTEND_URL=<the exact URL you open the app on>
```
`PAYPAL_API_BASE` must be empty (or `https://api-m.sandbox.paypal.com`); a live URL there with sandbox
keys fails with `invalid_client`. Restart the backend and the frontend after editing.
Apply the new migration first: `pnpm run prisma-migrate-deploy` (adds `PaypalPlan.environment`).

## 3. Test
1. Sign in as the account owner, open Billing. If Billing is missing, the backend log says
   `PayPal is not configured: missing ...` or `PAYPAL_MODE "..." is neither sandbox nor live`.
2. **Buy credits** > Buy a pack. You land on sandbox.paypal.com: log in with the **sandbox Personal**
   email and password (not your real account), click Pay. You return to `/billing/topup-return` and
   should see "N credits were added to your balance."
3. **Subscribe** to a tier, approve with the same sandbox buyer. Back on Billing the tier shows as
   your current plan. Its monthly credits arrive with the `PAYMENT.SALE.COMPLETED` webhook, so they
   need the webhook URL from step 1.3 to reach this backend (or the daily 04:00 UTC poll).

## 4. If it fails
- The screen now shows PayPal's reason ("PayPal refused the request: ...").
- Backend log: search for `PayPal answered`, e.g.
  `POST /v1/oauth2/token: PayPal answered 401 invalid_client: Client Authentication failed [debug_id ...]`
  - `invalid_client`: id/secret are wrong or from the other mode (live keys with sandbox, or reverse).
  - `422 ... (PAYEE_ACCOUNT_RESTRICTED)` and similar: the sandbox business account has a problem;
    check it under Sandbox Accounts.
  - Give the `debug_id` to PayPal support if needed.
- Going back to live later: `PAYPAL_MODE=live` with the **Live** app's id, secret and webhook id.
  Plans are recreated per environment automatically; sandbox plan ids are never sent to live.
