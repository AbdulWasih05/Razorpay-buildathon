-- AlterTable
ALTER TABLE "Dispute" ADD COLUMN     "abstentionClass" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "collectedJson" JSONB,
ADD COLUMN     "contestDraftJson" JSONB,
ADD COLUMN     "gateDecision" TEXT,
ADD COLUMN     "gateReason" TEXT,
ADD COLUMN     "state" TEXT NOT NULL DEFAULT 'received',
ADD COLUMN     "submittedRequestJson" JSONB;
