import type { RepositoryScope } from './repositories.js';
import type { LocalEvidencePacket } from './evidence-extraction.js';

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

// Trusted application input, never accepted from the model's analysis JSON.
// IDs identify immutable confirmation records; revocation must remain observable.
export interface ClaimConfirmation extends RepositoryScope {
  readonly id: string;
  readonly workItemId: string;
  readonly inputVersion: string;
  readonly claimId: string;
  readonly text: string;
  readonly status: 'confirmed' | 'revoked';
}

export interface WorkItem extends RepositoryScope {
  readonly id: string;
  readonly title: string;
  readonly status: 'in_progress' | 'completed' | 'unknown';
  readonly completedAt: string | null;
  readonly sourceRecordIds: readonly string[];
}

export interface EvidencePacket extends RepositoryScope {
  readonly workItemId: string;
  // Hash of the entire mapped input, including source bindings and mapping policy.
  readonly version: string;
  readonly complete: boolean;
  readonly provenance: {
    readonly kind: 'local_git';
    readonly mappingVersion: string;
    readonly contentVersion: string;
    // Extraction policy, grouping, contribution, omissions and blob identities.
    readonly local: Omit<LocalEvidencePacket, 'excerpts' | 'complete'>;
    readonly sources: readonly EvidenceSourceBinding[];
  };
  readonly excerpts: readonly {
    readonly id: string;
    readonly reference: EvidenceReference;
    readonly text: string;
    readonly complete: boolean;
    readonly commitOid: string;
    readonly parentOid: string | null;
    readonly path: string | null;
  }[];
}

// Supplied by the caller that associates a local commit with a source snapshot.
// The converter never invents persistent IDs or grants access to these scopes.
export interface EvidenceSourceBinding extends RepositoryScope {
  readonly commitOid: string;
  readonly sourceRecordId: string;
  readonly sourceVersion: string;
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
