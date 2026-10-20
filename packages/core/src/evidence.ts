import type { RepositoryScope } from './repositories.js';

export const SOURCE_KINDS = [
  'commit', 'pull_request', 'issue', 'review', 'check', 'user_note',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface EvidenceReference {
  readonly sourceRecordId: string;
  readonly sourceVersion: string;
  readonly locator: string | null;
}

interface ClaimBase {
  readonly id: string;
  readonly text: string;
}

export type Claim = ClaimBase & (
  | { readonly status: 'source_supported'; readonly evidence: readonly [EvidenceReference, ...EvidenceReference[]] }
  | { readonly status: 'user_confirmed'; readonly confirmationId: string; readonly evidence: readonly EvidenceReference[] }
  | { readonly status: 'inferred' | 'missing'; readonly evidence: readonly EvidenceReference[] }
);

export interface WorkItem extends RepositoryScope {
  readonly id: string;
  readonly title: string;
  readonly status: 'in_progress' | 'completed' | 'unknown';
  readonly completedAt: string | null;
  readonly sourceRecordIds: readonly string[];
}

export interface EvidencePacket extends RepositoryScope {
  readonly workItemId: string;
  readonly version: string;
  readonly complete: boolean;
  readonly excerpts: readonly {
    readonly reference: EvidenceReference;
    readonly text: string;
  }[];
}

export interface WorkItemAnalysis {
  readonly workItemId: string;
  readonly inputVersion: string;
  readonly problem: readonly Claim[];
  readonly constraints: readonly Claim[];
  readonly alternatives: readonly Claim[];
  readonly decision: readonly Claim[];
  readonly implementation: readonly Claim[];
  readonly results: readonly Claim[];
  readonly verification: readonly Claim[];
  readonly contribution: readonly Claim[];
  readonly missingQuestions: readonly string[];
}

export interface ResumeBullet {
  readonly workItemId: string;
  readonly text: string;
  readonly claimIds: readonly string[];
}
