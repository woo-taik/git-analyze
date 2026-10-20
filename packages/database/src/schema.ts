import { REPOSITORY_PROVIDERS, SOURCE_KINDS } from '@git-analyze/core';
import {
  foreignKey, index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';

export const repositoryProvider = pgEnum('repository_provider', REPOSITORY_PROVIDERS);
export const sourceKind = pgEnum('source_kind', SOURCE_KINDS);

export const owners = pgTable('owners', {
  id: uuid('id').defaultRandom().primaryKey(),
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const repositories = pgTable('repositories', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerId: uuid('owner_id').references(() => owners.id).notNull(),
  provider: repositoryProvider('provider').notNull(),
  instance: text('instance').notNull(),
  externalId: text('external_id').notNull(),
  label: text('label').notNull(),
  // Credentials are resolved elsewhere; never put a password into location.
  location: text('location').notNull(),
  credentialRef: text('credential_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('repositories_id_owner_unique').on(table.id, table.ownerId),
  unique('repositories_identity_unique').on(table.ownerId, table.provider, table.instance, table.externalId),
]);

// Append a version when source content changes; preserve earlier evidence.
export const sourceRecords = pgTable('source_records', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  repositoryId: uuid('repository_id').notNull(),
  kind: sourceKind('kind').notNull(),
  externalId: text('external_id').notNull(),
  version: text('version').notNull(),
  url: text('url'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }),
  observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow().notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
}, (table) => [
  foreignKey({
    name: 'source_records_repository_owner_fk',
    columns: [table.repositoryId, table.ownerId],
    foreignColumns: [repositories.id, repositories.ownerId],
  }),
  unique('source_records_version_unique').on(
    table.ownerId, table.repositoryId, table.kind, table.externalId, table.version,
  ),
  index('source_records_period_idx').on(table.ownerId, table.repositoryId, table.occurredAt),
]);
