export const REPOSITORY_PROVIDERS = [
  'github',
  'ncloud-sourcecommit',
  'git',
  'local',
] as const;

export type RepositoryProviderKind = (typeof REPOSITORY_PROVIDERS)[number];

export const REPOSITORY_CAPABILITIES = [
  'commits',
  'diff',
  'refs',
  'pull_requests',
  'issues',
  'reviews',
  'checks',
  'webhooks',
] as const;

export type Capability = (typeof REPOSITORY_CAPABILITIES)[number];
export type CapabilityState =
  | 'supported'
  | 'unsupported'
  | 'unknown'
  | 'permission_denied';
export type RepositoryCapabilities = Readonly<Record<Capability, CapabilityState>>;

export interface RepositoryScope {
  readonly ownerId: string;
  readonly repositoryId: string;
}

export interface RepositoryConnection extends RepositoryScope {
  readonly provider: RepositoryProviderKind;
  readonly instance: string;
  readonly location:
    | { readonly kind: 'remote'; readonly url: string; readonly credentialRef: string | null }
    | { readonly kind: 'local'; readonly path: string };
  readonly refs: readonly string[];
}

export interface ProviderDefinition {
  readonly id: RepositoryProviderKind;
  readonly label: string;
  readonly transports: readonly ('git' | 'api' | 'filesystem')[];
  // Documented capabilities are not a claim that an adapter is implemented.
  readonly documentedCapabilities: RepositoryCapabilities;
  readonly implementationStatus: 'planned' | 'implemented';
}

export interface CommitRecord extends RepositoryScope {
  readonly oid: string;
  readonly parentOids: readonly string[];
  readonly author: { readonly name: string; readonly email: string };
  readonly committer: { readonly name: string; readonly email: string };
  readonly authoredAt: string;
  readonly committedAt: string;
  readonly observedAt: string;
  readonly message: string;
}

export interface RepositoryReader {
  capabilities(connection: RepositoryConnection): Promise<RepositoryCapabilities>;
  // Discover new reachable objects by OID/ref, not by commit date alone.
  readCommits(input: {
    readonly connection: RepositoryConnection;
    readonly previousTips: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): AsyncIterable<CommitRecord>;
  readDiff(input: {
    readonly connection: RepositoryConnection;
    readonly oid: string;
    readonly parentOid: string | null;
    readonly maxBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly text: string; readonly complete: boolean }>;
}
