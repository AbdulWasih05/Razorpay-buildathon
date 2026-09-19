-- Provider-neutral dispute and payment columns.
--
-- Written by hand rather than generated: Prisma sees a rename as a drop plus an
-- add, which would discard every id it is renaming. These are ALTER ... RENAME
-- statements, so existing rows keep their ids.
--
-- The corpus columns become nullable in the same step. They describe a
-- GENERATED dispute -- which scenario produced it, what the corpus says the
-- answer is -- and a dispute that arrives from a provider has none of that. A
-- schema that demands them cannot store a real dispute at all.

CREATE TYPE "Provider" AS ENUM ('razorpay', 'stripe');

-- Payment ------------------------------------------------------------------
ALTER TABLE "Payment" ADD COLUMN "provider" "Provider" NOT NULL DEFAULT 'razorpay';
ALTER TABLE "Payment" RENAME COLUMN "razorpayPaymentId" TO "providerPaymentId";
DROP INDEX IF EXISTS "Payment_razorpayPaymentId_key";
CREATE UNIQUE INDEX "Payment_provider_providerPaymentId_key" ON "Payment"("provider", "providerPaymentId");

-- Dispute ------------------------------------------------------------------
ALTER TABLE "Dispute" ADD COLUMN "provider" "Provider" NOT NULL DEFAULT 'razorpay';
ALTER TABLE "Dispute" RENAME COLUMN "razorpayDisputeId" TO "providerDisputeId";
ALTER TABLE "Dispute" RENAME COLUMN "razorpayPaymentId" TO "providerPaymentId";
ALTER TABLE "Dispute" ADD COLUMN "network" TEXT;

-- A provider that is not Razorpay does not settle in rupees.
ALTER TABLE "Dispute" ALTER COLUMN "currency" DROP DEFAULT;

ALTER TABLE "Dispute" ALTER COLUMN "scenarioClass" DROP NOT NULL;
ALTER TABLE "Dispute" ALTER COLUMN "corpus" DROP NOT NULL;
ALTER TABLE "Dispute" ALTER COLUMN "seed" DROP NOT NULL;
ALTER TABLE "Dispute" ALTER COLUMN "groundTruth" DROP NOT NULL;
ALTER TABLE "Dispute" ALTER COLUMN "groundTruthRationale" DROP NOT NULL;

DROP INDEX IF EXISTS "Dispute_razorpayDisputeId_key";
DROP INDEX IF EXISTS "Dispute_razorpayPaymentId_idx";
CREATE UNIQUE INDEX "Dispute_provider_providerDisputeId_key" ON "Dispute"("provider", "providerDisputeId");
CREATE INDEX "Dispute_providerPaymentId_idx" ON "Dispute"("providerPaymentId");
