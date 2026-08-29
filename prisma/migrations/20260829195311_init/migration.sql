-- CreateEnum
CREATE TYPE "MandateStatus" AS ENUM ('active', 'expired', 'revoked', 'exhausted');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('placed', 'confirmed', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "FulfillmentStatus" AS ENUM ('pending', 'shipped', 'delivered', 'returned', 'failed');

-- CreateEnum
CREATE TYPE "Rail" AS ENUM ('ordinary', 'agentic');

-- CreateEnum
CREATE TYPE "TurnRole" AS ENUM ('customer', 'agent', 'system');

-- CreateEnum
CREATE TYPE "Corpus" AS ENUM ('dev', 'ood_holdout');

-- CreateEnum
CREATE TYPE "GroundTruth" AS ENUM ('winnable', 'unwinnable', 'ambiguous');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mandate" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentPlatform" TEXT NOT NULL,
    "payerVpa" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "maxAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "MandateStatus" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mandate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "OrderStatus" NOT NULL,
    "itemsJson" JSONB NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "razorpayPaymentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "vpa" TEXT,
    "capturedAt" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fulfillment" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "FulfillmentStatus" NOT NULL,
    "carrier" TEXT,
    "trackingId" TEXT,
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "proofRef" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fulfillment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidencePack" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "mandateId" TEXT,
    "rail" "Rail" NOT NULL,
    "agentId" TEXT,
    "agentPlatform" TEXT,
    "protocol" TEXT,
    "protocolVersion" TEXT,
    "protocolMetadata" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidencePack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationTrace" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "evidencePackId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationTrace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationTurn" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" "TurnRole" NOT NULL,
    "content" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrchestrationLog" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "evidencePackId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrchestrationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "razorpayDisputeId" TEXT NOT NULL,
    "razorpayPaymentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "amountDeducted" INTEGER NOT NULL DEFAULT 0,
    "reasonCode" TEXT NOT NULL,
    "reasonDescription" TEXT,
    "respondBy" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL,
    "evidenceJson" JSONB,
    "externalId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "rail" "Rail" NOT NULL,
    "scenarioClass" TEXT NOT NULL,
    "corpus" "Corpus" NOT NULL,
    "seed" TEXT NOT NULL,
    "groundTruth" "GroundTruth" NOT NULL,
    "groundTruthRationale" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "detail" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_externalId_key" ON "Merchant"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_externalId_key" ON "Customer"("externalId");

-- CreateIndex
CREATE INDEX "Customer_merchantId_idx" ON "Customer"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "Mandate_externalId_key" ON "Mandate"("externalId");

-- CreateIndex
CREATE INDEX "Mandate_merchantId_idx" ON "Mandate"("merchantId");

-- CreateIndex
CREATE INDEX "Mandate_customerId_idx" ON "Mandate"("customerId");

-- CreateIndex
CREATE INDEX "Mandate_agentId_idx" ON "Mandate"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_externalId_key" ON "Order"("externalId");

-- CreateIndex
CREATE INDEX "Order_merchantId_idx" ON "Order"("merchantId");

-- CreateIndex
CREATE INDEX "Order_customerId_idx" ON "Order"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_externalId_key" ON "Payment"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_razorpayPaymentId_key" ON "Payment"("razorpayPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_orderId_key" ON "Payment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Fulfillment_externalId_key" ON "Fulfillment"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Fulfillment_orderId_key" ON "Fulfillment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidencePack_externalId_key" ON "EvidencePack"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidencePack_orderId_key" ON "EvidencePack"("orderId");

-- CreateIndex
CREATE INDEX "EvidencePack_merchantId_idx" ON "EvidencePack"("merchantId");

-- CreateIndex
CREATE INDEX "EvidencePack_mandateId_idx" ON "EvidencePack"("mandateId");

-- CreateIndex
CREATE INDEX "EvidencePack_rail_idx" ON "EvidencePack"("rail");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTrace_externalId_key" ON "ConversationTrace"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTrace_evidencePackId_key" ON "ConversationTrace"("evidencePackId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTurn_externalId_key" ON "ConversationTurn"("externalId");

-- CreateIndex
CREATE INDEX "ConversationTurn_traceId_idx" ON "ConversationTurn"("traceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTurn_traceId_seq_key" ON "ConversationTurn"("traceId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "OrchestrationLog_externalId_key" ON "OrchestrationLog"("externalId");

-- CreateIndex
CREATE INDEX "OrchestrationLog_evidencePackId_idx" ON "OrchestrationLog"("evidencePackId");

-- CreateIndex
CREATE UNIQUE INDEX "OrchestrationLog_evidencePackId_seq_key" ON "OrchestrationLog"("evidencePackId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_razorpayDisputeId_key" ON "Dispute"("razorpayDisputeId");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_externalId_key" ON "Dispute"("externalId");

-- CreateIndex
CREATE INDEX "Dispute_corpus_idx" ON "Dispute"("corpus");

-- CreateIndex
CREATE INDEX "Dispute_rail_idx" ON "Dispute"("rail");

-- CreateIndex
CREATE INDEX "Dispute_scenarioClass_idx" ON "Dispute"("scenarioClass");

-- CreateIndex
CREATE INDEX "Dispute_razorpayPaymentId_idx" ON "Dispute"("razorpayPaymentId");

-- CreateIndex
CREATE INDEX "AuditLog_disputeId_idx" ON "AuditLog"("disputeId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_disputeId_seq_key" ON "AuditLog"("disputeId", "seq");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fulfillment" ADD CONSTRAINT "Fulfillment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidencePack" ADD CONSTRAINT "EvidencePack_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidencePack" ADD CONSTRAINT "EvidencePack_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidencePack" ADD CONSTRAINT "EvidencePack_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "Mandate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTrace" ADD CONSTRAINT "ConversationTrace_evidencePackId_fkey" FOREIGN KEY ("evidencePackId") REFERENCES "EvidencePack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTurn" ADD CONSTRAINT "ConversationTurn_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "ConversationTrace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrchestrationLog" ADD CONSTRAINT "OrchestrationLog_evidencePackId_fkey" FOREIGN KEY ("evidencePackId") REFERENCES "EvidencePack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
