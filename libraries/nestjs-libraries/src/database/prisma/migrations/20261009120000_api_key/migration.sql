-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");

-- CreateIndex
CREATE INDEX "ApiKey_organizationId_revokedAt_idx" ON "ApiKey"("organizationId", "revokedAt");

-- CreateIndex
CREATE INDEX "ApiKey_secretHash_idx" ON "ApiKey"("secretHash");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- LegacyKeys: each workspace key a client holds becomes a hashed, full-scope key
-- named "Legacy key". The hash is SHA-256 of the whole stored value, which is the string the
-- client sends, so that value keeps working. The legacy column holds no secret afterwards.
INSERT INTO "ApiKey" ("id", "organizationId", "name", "prefix", "secretHash", "scopes")
SELECT
    gen_random_uuid()::text,
    "id",
    'Legacy key',
    'legacy-' || "id",
    encode(sha256(convert_to("apiKey", 'UTF8')), 'hex'),
    ARRAY['posts:read', 'posts:write', 'media:write', 'channels:read', 'channels:write', 'ai:use', 'account:read']
FROM "Organization"
WHERE "apiKey" IS NOT NULL AND "apiKey" <> '';

UPDATE "Organization" SET "apiKey" = NULL WHERE "apiKey" IS NOT NULL;
