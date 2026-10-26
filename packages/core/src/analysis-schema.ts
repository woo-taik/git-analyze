export const ANALYSIS_SCHEMA_VERSION = 'work-item-analysis-v1';
export const ANALYSIS_CLAIM_FIELDS = [
  'problem', 'constraints', 'alternatives', 'decision',
  'implementation', 'results', 'verification', 'contribution',
] as const;

const identity = { type: 'string', minLength: 1, maxLength: 512, pattern: '\\S' } as const;
const text = { type: 'string', minLength: 1, maxLength: 4_096, pattern: '\\S' } as const;
const reference = {
  type: 'object', additionalProperties: false,
  required: ['sourceRecordId', 'sourceVersion', 'locator'],
  properties: {
    sourceRecordId: identity, sourceVersion: identity,
    locator: { anyOf: [{ ...text }, { type: 'null' }] },
  },
} as const;

function claim(status: 'source_supported' | 'user_confirmed' | 'inferred' | 'missing') {
  return {
    type: 'object', additionalProperties: false,
    required: ['id', 'text', 'status', 'evidence', ...(status === 'user_confirmed' ? ['confirmationId'] : [])],
    properties: {
      id: identity, text, status: { const: status, type: 'string' },
      evidence: { type: 'array', minItems: status === 'source_supported' ? 1 : 0,
        maxItems: 20, uniqueItems: true, items: reference },
      ...(status === 'user_confirmed' ? { confirmationId: identity } : {}),
    },
  };
}

// Provider-neutral draft-07 schema. Provider SDK-specific schema adaptation comes later.
export const WORK_ITEM_ANALYSIS_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: `urn:git-analyze:${ANALYSIS_SCHEMA_VERSION}`,
  type: 'object', additionalProperties: false,
  required: ['workItemId', 'inputVersion', ...ANALYSIS_CLAIM_FIELDS, 'missingQuestions'],
  properties: {
    workItemId: identity,
    inputVersion: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    ...Object.fromEntries(ANALYSIS_CLAIM_FIELDS.map((field) => [field, {
      type: 'array', maxItems: 32, items: { $ref: '#/definitions/claim' },
    }])),
    missingQuestions: { type: 'array', maxItems: 20, uniqueItems: true, items: text },
  },
  definitions: {
    claim: { oneOf: ['source_supported', 'user_confirmed', 'inferred', 'missing'].map((status) =>
      claim(status as Parameters<typeof claim>[0])) },
  },
} as const;
