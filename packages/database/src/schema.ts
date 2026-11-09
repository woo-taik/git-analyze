import { REPOSITORY_PROVIDERS, SOURCE_KINDS } from '@git-analyze/core';
import { sql } from 'drizzle-orm';
import {
  check, foreignKey, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';
import type { ArchivedAnalysis, ArchivedReview } from './work-archive.js';

export const repositoryProvider = pgEnum('repository_provider', REPOSITORY_PROVIDERS);
export const sourceKind = pgEnum('source_kind', SOURCE_KINDS);

export const owners = pgTable('owners', {
  id: uuid('id').defaultRandom().primaryKey(),
  externalId: text('external_id').unique(),
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
  unique('source_records_scope_unique').on(table.id, table.ownerId, table.repositoryId),
  index('source_records_period_idx').on(table.ownerId, table.repositoryId, table.occurredAt),
]);

export const workItems = pgTable('work_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  repositoryId: uuid('repository_id').notNull(),
  externalId: text('external_id').notNull(),
  title: text('title').notNull(),
}, (table) => [
  foreignKey({ name: 'work_items_repository_owner_fk', columns: [table.repositoryId, table.ownerId],
    foreignColumns: [repositories.id, repositories.ownerId] }),
  unique('work_items_identity_unique').on(table.ownerId, table.repositoryId, table.externalId),
  unique('work_items_scope_unique').on(table.id, table.ownerId, table.repositoryId),
]);

export const workItemSources = pgTable('work_item_sources', {
  workItemId: uuid('work_item_id').notNull(),
  sourceRecordId: uuid('source_record_id').notNull(),
  ownerId: uuid('owner_id').notNull(),
  repositoryId: uuid('repository_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.workItemId, table.sourceRecordId] }),
  foreignKey({ name: 'work_item_sources_work_scope_fk', columns: [table.workItemId, table.ownerId, table.repositoryId],
    foreignColumns: [workItems.id, workItems.ownerId, workItems.repositoryId] }),
  foreignKey({ name: 'work_item_sources_source_scope_fk', columns: [table.sourceRecordId, table.ownerId, table.repositoryId],
    foreignColumns: [sourceRecords.id, sourceRecords.ownerId, sourceRecords.repositoryId] }),
]);

export const workAnalysisVersions = pgTable('work_analysis_versions', {
  workItemId: uuid('work_item_id').references(() => workItems.id).notNull(),
  snapshotVersion: text('snapshot_version').notNull(),
  payload: jsonb('payload').$type<ArchivedAnalysis>().notNull(),
}, (table) => [primaryKey({ columns: [table.workItemId, table.snapshotVersion] })]);

export const workReviewVersions = pgTable('work_review_versions', {
  workItemId: uuid('work_item_id').notNull(),
  revision: integer('revision').notNull(),
  version: text('version').notNull(),
  previousVersion: text('previous_version'),
  snapshotVersion: text('snapshot_version').notNull(),
  payload: jsonb('payload').$type<ArchivedReview>().notNull(),
}, (table) => [
  primaryKey({ columns: [table.workItemId, table.revision] }),
  unique('work_review_versions_identity_unique').on(table.workItemId, table.version),
  foreignKey({ name: 'work_review_versions_analysis_fk', columns: [table.workItemId, table.snapshotVersion],
    foreignColumns: [workAnalysisVersions.workItemId, workAnalysisVersions.snapshotVersion] }),
  foreignKey({ name: 'work_review_versions_previous_fk', columns: [table.workItemId, table.previousVersion],
    foreignColumns: [table.workItemId, table.version] }),
  check('work_review_versions_previous_check', sql`(${table.revision} = 1 AND ${table.previousVersion} IS NULL)
    OR (${table.revision} > 1 AND ${table.previousVersion} IS NOT NULL)`),
]);
