# Archived migrations

These two migrations are **not applied** and are kept only for the record.
Prisma reads `prisma/migrations`; this directory is outside it and is ignored.

The original migration history was lost. Only these two survived, and neither
could build a database on its own — the baseline that created the twenty-five
tables they alter was gone. `prisma/migrations/0_init` replaces them, generated
strictly from `schema.prisma`.

Everything they created is already contained in that baseline, with one
deliberate exception:

`20260801000000_data_purged_audit_verb` appends `DATA_PURGED` to the
`AuditAction` enum. `schema.prisma` does not declare that value and no code
references it — the migration is from a revision ahead of the recovered schema.
Applying it would leave every deployment permanently drifted from its own
schema, so the baseline omits it. If a future change genuinely needs that verb,
add it to `schema.prisma` and generate a new migration; do not resurrect this
file.

Both were written idempotently (`ADD VALUE IF NOT EXISTS`,
`CREATE TABLE IF NOT EXISTS`, `duplicate_object` guards, `ON CONFLICT DO
NOTHING`), which is the only reason keeping them in front of the baseline was
ever considered.
