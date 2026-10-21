import type { ProviderDefinition, RepositoryCapabilities } from '@git-analyze/core';

const gitOnly = {
  commits: 'supported',
  diff: 'supported',
  refs: 'supported',
  pull_requests: 'unknown',
  issues: 'unknown',
  reviews: 'unknown',
  checks: 'unknown',
  webhooks: 'unknown',
} as const satisfies RepositoryCapabilities;


export const PROVIDER_CATALOG = [
  {
    id: 'github', label: 'GitHub', transports: ['git', 'api'], implementationStatus: 'planned',
    documentedCapabilities: {
      commits: 'supported', diff: 'supported', refs: 'supported',
      pull_requests: 'supported', issues: 'supported', reviews: 'supported',
      checks: 'supported', webhooks: 'supported',
    },
  },
  {
    id: 'ncloud-sourcecommit', label: 'Ncloud SourceCommit', transports: ['git'],
    implementationStatus: 'planned', documentedCapabilities: gitOnly,
  },
  {
    id: 'git', label: 'Generic Git remote', transports: ['git'],
    implementationStatus: 'planned', documentedCapabilities: gitOnly,
  },
  {
    id: 'local', label: 'Local Git repository', transports: ['filesystem'],
    implementationStatus: 'implemented',
    documentedCapabilities: {
      ...gitOnly, pull_requests: 'unsupported', issues: 'unsupported',
      reviews: 'unsupported', checks: 'unsupported', webhooks: 'unsupported',
    },
  },
] as const satisfies readonly ProviderDefinition[];
