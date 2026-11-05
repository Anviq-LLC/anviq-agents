CREATE TABLE "user_integration_provider_configs" (
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_integration_provider_configs_pkey" PRIMARY KEY ("userId", "provider"),
  CONSTRAINT "user_integration_provider_configs_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "user_integration_provider_configs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_integration_provider_configs_tenant ON "user_integration_provider_configs"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_integration_provider_configs_system ON "user_integration_provider_configs"
  USING (current_setting('app.rls_bypass', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anviq_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "user_integration_provider_configs" TO anviq_app;
  END IF;
END $$;
