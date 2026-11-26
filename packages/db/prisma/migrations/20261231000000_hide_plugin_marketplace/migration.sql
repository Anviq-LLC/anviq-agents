-- Additive: the previous release never reads this column.
ALTER TABLE "user" ADD COLUMN "hidePluginMarketplace" BOOLEAN NOT NULL DEFAULT false;
