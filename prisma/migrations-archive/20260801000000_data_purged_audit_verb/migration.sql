-- One more audit verb, for the admin storage panel's collection clearing.
--
-- Strictly additive. An enum value is appended and nothing else is touched: no
-- column is dropped, no table truncated, no existing row altered. Messages,
-- attachments and chat history are unaffected by this migration.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DATA_PURGED';
