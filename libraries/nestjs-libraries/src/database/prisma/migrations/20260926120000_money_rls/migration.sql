-- Money-table row-level security: on the API role, the credit tables show and accept only
-- rows of the account set for the current transaction (setting app.account_id, set by MoneyScope).
-- The worker role bypasses this. Rows are not changed.

ALTER TABLE "CreditBucket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CreditBucket" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CreditBucket_account" ON "CreditBucket" FOR ALL
  USING ("accountId" = current_setting('app.account_id', true))
  WITH CHECK ("accountId" = current_setting('app.account_id', true));

ALTER TABLE "CreditLedger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CreditLedger" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CreditLedger_account" ON "CreditLedger" FOR ALL
  USING ("accountId" = current_setting('app.account_id', true))
  WITH CHECK ("accountId" = current_setting('app.account_id', true));

ALTER TABLE "CreditEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CreditEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CreditEntry_account" ON "CreditEntry" FOR ALL
  USING ("accountId" = current_setting('app.account_id', true))
  WITH CHECK ("accountId" = current_setting('app.account_id', true));
