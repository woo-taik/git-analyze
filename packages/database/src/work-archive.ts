import { createHash } from 'node:crypto';
import { canonicalJson, validateReviewState, validateWorkItemAnalysis,
  type EvidencePacket, type LlmUsage, type ReviewState, type WorkItemAnalysis } from '@git-analyze/core';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { createDatabase } from './index.js';
import { owners, repositories, sourceRecords, workAnalysisVersions, workItems, workItemSources, workReviewVersions } from './schema.js';

export type ArchiveScope = Pick<EvidencePacket, 'ownerId' | 'repositoryId' | 'workItemId'>;
export class ArchiveNotFoundError extends Error {
  constructor() {
    super('Archived work item was not found');
    this.name = 'ArchiveNotFoundError';
  }
}

export interface ArchivedWorkSummary {
  readonly workItemId: string;
  readonly title: string;
  readonly revision: number;
  readonly reviewVersion: string;
}

export interface ArchivedAnalysis {
  readonly analysisVersion: string;
  readonly packet: EvidencePacket;
  readonly analysis: WorkItemAnalysis;
  readonly usage: LlmUsage;
  readonly request: { readonly promptVersion: string; readonly wireSchemaVersion: string; readonly requestedModel: string };
  readonly source: {
    readonly inputFile: string; readonly contentVersion: string; readonly repositoryPath: string;
    readonly ref: string | null; readonly tipOid: string; readonly startAt: string; readonly endAt: string;
    readonly commitCount: number; readonly pathFilter: string | null;
  };
}

export interface ArchivedReview {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly previousVersion: string | null;
  readonly analysisFile: string;
  readonly analysisVersion: string;
  readonly state: ReviewState;
}

export interface WorkArchiveRevision {
  readonly version: string;
  readonly review: ArchivedReview;
  readonly analysis: ArchivedAnalysis;
}

type Database = ReturnType<typeof createDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const localInstance = 'local-review';

function validateRevision(scope: ArchiveScope, entry: WorkArchiveRevision) {
  const { analysis, review, version } = entry;
  const packet = analysis.packet;
  if (packet.ownerId !== scope.ownerId || packet.repositoryId !== scope.repositoryId || packet.workItemId !== scope.workItemId
    || analysis.analysisVersion !== hash({ ownerId: scope.ownerId, repositoryId: scope.repositoryId, workItemId: scope.workItemId,
      inputVersion: packet.version, analysis: analysis.analysis })
    || review.analysisVersion !== analysis.analysisVersion || review.schemaVersion !== 1 || hash(review) !== version) {
    throw new Error('Archived review scope or version does not match');
  }
  const context = { packet, analysis: validateWorkItemAnalysis(analysis.analysis, { packet }), analysisVersion: analysis.analysisVersion };
  return { version, context, stored: { revision: review.revision, state: validateReviewState(review.state, context) }, saved: { source: analysis.source } };
}

export type ArchivedReviewSnapshot = ReturnType<typeof validateRevision>;

/** Read bounded summaries without loading the archived evidence or local file paths. */
export async function listArchivedWorks(db: Database, scope: Pick<ArchiveScope, 'ownerId' | 'repositoryId'>,
  page: { readonly limit: number; readonly offset: number }): Promise<{
    items: ArchivedWorkSummary[]; nextOffset: number | null;
  }> {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100
    || !Number.isSafeInteger(page.offset) || page.offset < 0 || page.offset > Number.MAX_SAFE_INTEGER - page.limit) {
    throw new Error('Invalid archive pagination');
  }
  const latest = db.select({ revision: workReviewVersions.revision, version: workReviewVersions.version })
    .from(workReviewVersions).where(eq(workReviewVersions.workItemId, workItems.id))
    .orderBy(desc(workReviewVersions.revision)).limit(1).as('latest_review');
  const rows = await db.select({ workItemId: workItems.externalId, title: workItems.title,
    revision: latest.revision, reviewVersion: latest.version }).from(workItems)
    .innerJoin(repositories, and(eq(workItems.repositoryId, repositories.id), eq(workItems.ownerId, repositories.ownerId)))
    .innerJoin(owners, eq(workItems.ownerId, owners.id))
    .innerJoinLateral(latest, sql`true`)
    .where(and(eq(owners.externalId, scope.ownerId), eq(repositories.provider, 'local'),
      eq(repositories.instance, localInstance), eq(repositories.externalId, scope.repositoryId)))
    .orderBy(asc(workItems.externalId), asc(workItems.id)).limit(page.limit + 1).offset(page.offset);
  return { items: rows.slice(0, page.limit), nextOffset: rows.length > page.limit ? page.offset + page.limit : null };
}

async function lockWork(tx: Transaction, scope: ArchiveScope) {
  const [work] = await tx.select({ id: workItems.id, ownerId: workItems.ownerId, repositoryId: workItems.repositoryId }).from(workItems)
    .innerJoin(repositories, and(eq(workItems.repositoryId, repositories.id), eq(workItems.ownerId, repositories.ownerId)))
    .innerJoin(owners, eq(workItems.ownerId, owners.id))
    .where(and(eq(owners.externalId, scope.ownerId), eq(repositories.provider, 'local'), eq(repositories.instance, localInstance),
      eq(repositories.externalId, scope.repositoryId), eq(workItems.externalId, scope.workItemId)))
    .for('update', { of: workItems });
  if (!work) throw new ArchiveNotFoundError();
  return work;
}

async function linkSources(tx: Transaction, work: Awaited<ReturnType<typeof lockWork>>, packet: EvidencePacket) {
  const scope = { ownerId: work.ownerId, repositoryId: work.repositoryId };
  for (const binding of packet.provenance.sources) {
    const commit = packet.provenance.local.commits.find(({ oid }) => oid === binding.commitOid);
    if (!commit) throw new Error('Archived source does not match a commit');
    const key = { ...scope, kind: 'commit' as const, externalId: commit.oid, version: binding.sourceVersion };
    await tx.insert(sourceRecords).values({ ...key, occurredAt: new Date(commit.committedAt),
      payload: { oid: commit.oid, parentOid: commit.parentOid, authoredAt: commit.authoredAt, committedAt: commit.committedAt } }).onConflictDoNothing();
    const [source] = await tx.select({ id: sourceRecords.id }).from(sourceRecords).where(and(eq(sourceRecords.ownerId, key.ownerId),
      eq(sourceRecords.repositoryId, key.repositoryId), eq(sourceRecords.kind, key.kind), eq(sourceRecords.externalId, key.externalId),
      eq(sourceRecords.version, key.version)));
    if (!source) throw new Error('Could not resolve archived source');
    await tx.insert(workItemSources).values({ ...scope, workItemId: work.id, sourceRecordId: source.id }).onConflictDoNothing();
  }
}

/** Store an entire validated chain, or leave the database at its previous revision. */
export async function archiveWork(db: Database, scope: ArchiveScope, revisions: readonly WorkArchiveRevision[]) {
  const latest = revisions.at(-1);
  if (!latest) throw new Error('An archived work item needs a review revision');
  const versions = revisions.map((entry, index) => {
    if (entry.review.revision !== index + 1 || entry.review.previousVersion !== (revisions[index - 1]?.version ?? null)) {
      throw new Error('Archived review history is not contiguous');
    }
    validateRevision(scope, entry);
    return hash(entry.analysis);
  });

  return db.transaction(async (tx) => {
    await tx.insert(owners).values({ externalId: scope.ownerId, label: scope.ownerId }).onConflictDoNothing();
    const [owner] = await tx.select({ id: owners.id }).from(owners).where(eq(owners.externalId, scope.ownerId));
    if (!owner) throw new Error('Could not resolve archive owner');
    await tx.insert(repositories).values({ ownerId: owner.id, provider: 'local', instance: localInstance,
      externalId: scope.repositoryId, label: scope.repositoryId, location: latest.analysis.source.repositoryPath }).onConflictDoNothing();
    const [repository] = await tx.select({ id: repositories.id }).from(repositories).where(and(eq(repositories.ownerId, owner.id),
      eq(repositories.provider, 'local'), eq(repositories.instance, localInstance), eq(repositories.externalId, scope.repositoryId)));
    if (!repository) throw new Error('Could not resolve archive repository');
    await tx.insert(workItems).values({ ownerId: owner.id, repositoryId: repository.id, externalId: scope.workItemId,
      title: latest.analysis.packet.provenance.local.selection.title }).onConflictDoNothing();
    const work = await lockWork(tx, scope);
    const existing = await tx.select({ revision: workReviewVersions.revision, version: workReviewVersions.version,
      snapshotVersion: workReviewVersions.snapshotVersion }).from(workReviewVersions).where(eq(workReviewVersions.workItemId, work.id))
      .orderBy(asc(workReviewVersions.revision));
    if (existing.length > revisions.length) throw new Error('Database has a newer review revision');
    if (existing.some((row, index) => row.revision !== index + 1 || row.version !== revisions[index]!.version
      || row.snapshotVersion !== versions[index])) throw new Error('Database and local review histories diverged');

    const known = new Set(existing.map((row) => row.snapshotVersion));
    for (const [index, entry] of revisions.entries()) {
      if (index < existing.length) continue;
      const snapshotVersion = versions[index]!;
      if (!known.has(snapshotVersion)) {
        await linkSources(tx, work, entry.analysis.packet);
        await tx.insert(workAnalysisVersions).values({ workItemId: work.id, snapshotVersion, payload: entry.analysis });
        known.add(snapshotVersion);
      }
      await tx.insert(workReviewVersions).values({ workItemId: work.id, revision: entry.review.revision, version: entry.version,
        previousVersion: entry.review.previousVersion, snapshotVersion, payload: entry.review });
    }
    return { version: latest.version, revision: latest.review.revision, insertedRevisions: revisions.length - existing.length };
  });
}

export async function withArchivedReview<T>(db: Database, scope: ArchiveScope,
  operation: (current: ArchivedReviewSnapshot) => Promise<T>) {
  return db.transaction(async (tx) => {
    const work = await lockWork(tx, scope);
    const [entry] = await tx.select({ version: workReviewVersions.version, revision: workReviewVersions.revision,
      previousVersion: workReviewVersions.previousVersion, snapshotVersion: workReviewVersions.snapshotVersion,
      review: workReviewVersions.payload, analysis: workAnalysisVersions.payload }).from(workReviewVersions)
      .innerJoin(workAnalysisVersions, and(eq(workReviewVersions.workItemId, workAnalysisVersions.workItemId),
        eq(workReviewVersions.snapshotVersion, workAnalysisVersions.snapshotVersion)))
      .where(eq(workReviewVersions.workItemId, work.id)).orderBy(desc(workReviewVersions.revision)).limit(1);
    if (!entry || entry.revision !== entry.review.revision || entry.previousVersion !== entry.review.previousVersion
      || entry.snapshotVersion !== hash(entry.analysis)) throw new Error('Archived review or analysis is invalid');
    return operation(validateRevision(scope, entry));
  });
}
