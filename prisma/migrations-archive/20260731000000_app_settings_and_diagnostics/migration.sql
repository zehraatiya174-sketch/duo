-- Instance-wide settings, server error logs, and two more storage providers.
--
-- Strictly additive. Nothing here drops a column, truncates a table, or alters
-- an existing row: enum values are appended, and the two new tables start
-- empty. Existing messages, attachments and chat history are untouched.

-- Two more object stores behind the same driver interface.
ALTER TYPE "StorageProvider" ADD VALUE IF NOT EXISTS 'SUPABASE';
ALTER TYPE "StorageProvider" ADD VALUE IF NOT EXISTS 'B2';

-- New audit verbs for the admin controls and the verification gate.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APP_SETTINGS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISAPPEARING_MODE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MESSAGES_HIDDEN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MESSAGES_RESTORED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'VERIFICATION_PASSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'VERIFICATION_FAILED';

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "ErrorSeverity" AS ENUM ('WARN', 'ERROR', 'FATAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "app_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "disappearingMode" BOOLEAN NOT NULL DEFAULT false,
    "disappearingRule" "EphemeralMode" NOT NULL DEFAULT 'VIEW_ONCE',
    "disappearingMaxViews" INTEGER,
    "disappearingExpiresInSeconds" INTEGER,
    "messagesHiddenBefore" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "error_logs" (
    "id" TEXT NOT NULL,
    "severity" "ErrorSeverity" NOT NULL DEFAULT 'ERROR',
    "scope" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "error_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "error_logs_createdAt_idx" ON "error_logs"("createdAt" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "error_logs_severity_createdAt_idx" ON "error_logs"("severity", "createdAt" DESC);

-- AddForeignKey
-- The editor is recorded for the audit trail only, so losing the account must
-- not lose the setting: SET NULL rather than CASCADE.
DO $$
BEGIN
  ALTER TABLE "app_settings"
    ADD CONSTRAINT "app_settings_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Seed the singleton with the switch off, which is exactly how the app behaved
-- before this migration existed.
INSERT INTO "app_settings" ("id", "disappearingMode", "updatedAt")
VALUES ('global', false, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
