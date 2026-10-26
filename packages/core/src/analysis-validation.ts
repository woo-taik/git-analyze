import { Ajv } from 'ajv';
import { ANALYSIS_CLAIM_FIELDS, WORK_ITEM_ANALYSIS_SCHEMA } from './analysis-schema.js';
import type { ClaimConfirmation, EvidencePacket, EvidenceReference, WorkItemAnalysis } from './evidence.js';

export const MAX_ANALYSIS_JSON_BYTES = 1_048_576;
export type AnalysisValidationCode = 'invalid_json' | 'output_limit' | 'invalid_schema' | 'work_item_mismatch'
  | 'input_version_mismatch' | 'duplicate_claim_id' | 'unknown_evidence' | 'invalid_confirmation';

export class AnalysisValidationError extends Error {
  constructor(readonly code: AnalysisValidationCode, readonly path: string) {
    // Do not echo model text, source contents or identifiers into diagnostics.
    super(`Analysis validation failed: ${code} at ${path}`);
    this.name = 'AnalysisValidationError';
  }
}

export interface AnalysisValidationContext {
  // Both inputs come from the trusted application layer, outside model output.
  readonly packet: EvidencePacket;
  readonly confirmations?: readonly ClaimConfirmation[];
}

const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false, removeAdditional: false, useDefaults: false });
const checkSchema = ajv.compile<WorkItemAnalysis>(WORK_ITEM_ANALYSIS_SCHEMA);
const referenceKey = (reference: EvidenceReference) => JSON.stringify([
  reference.sourceRecordId, reference.sourceVersion, reference.locator,
]);

/** Validates a decoded JSON value without coercion, pruning or approving its meaning. */
export function validateWorkItemAnalysis(value: unknown, context: AnalysisValidationContext): WorkItemAnalysis {
  if (!checkSchema(value)) {
    // Paths are schema-controlled; additional property names and invalid values are not exposed.
    throw new AnalysisValidationError('invalid_schema', checkSchema.errors?.[0]?.instancePath || '/');
  }
  const { packet } = context;
  if (value.workItemId !== packet.workItemId) throw new AnalysisValidationError('work_item_mismatch', '/workItemId');
  if (value.inputVersion !== packet.version) throw new AnalysisValidationError('input_version_mismatch', '/inputVersion');
  const references = new Set(packet.excerpts.filter((excerpt) => excerpt.text.trim()).map((excerpt) => referenceKey(excerpt.reference)));
  const confirmations = new Map<string, ClaimConfirmation[]>();
  for (const confirmation of context.confirmations ?? []) {
    const records = confirmations.get(confirmation.id) ?? [];
    records.push(confirmation);
    confirmations.set(confirmation.id, records);
  }
  const claimIds = new Set<string>();
  for (const field of ANALYSIS_CLAIM_FIELDS) {
    for (const [index, claim] of value[field].entries()) {
      const path = `/${field}/${index}`;
      if (claimIds.has(claim.id)) throw new AnalysisValidationError('duplicate_claim_id', `${path}/id`);
      claimIds.add(claim.id);
      for (const [referenceIndex, reference] of claim.evidence.entries()) {
        if (!references.has(referenceKey(reference))) {
          throw new AnalysisValidationError('unknown_evidence', `${path}/evidence/${referenceIndex}`);
        }
      }
      if (claim.status === 'user_confirmed') {
        const matches = confirmations.get(claim.confirmationId);
        const record = matches?.[0];
        if (matches?.length !== 1 || !record || record.status !== 'confirmed'
          || record.ownerId !== packet.ownerId || record.repositoryId !== packet.repositoryId
          || record.workItemId !== packet.workItemId || record.inputVersion !== packet.version
          || record.claimId !== claim.id || record.text !== claim.text) {
          throw new AnalysisValidationError('invalid_confirmation', `${path}/confirmationId`);
        }
      }
    }
  }
  // Caller edits after validation must not modify the value passed to persistence.
  return structuredClone(value);
}

/** Parses one complete bounded JSON response; code fences, trailing text and truncation are errors. */
export function parseWorkItemAnalysis(json: string, context: AnalysisValidationContext): WorkItemAnalysis {
  if (typeof json !== 'string') throw new AnalysisValidationError('invalid_json', '/');
  // Character count is only an inexpensive early bound; enforce the actual UTF-8 byte bound too.
  if (json.length > MAX_ANALYSIS_JSON_BYTES || new TextEncoder().encode(json).length > MAX_ANALYSIS_JSON_BYTES) {
    throw new AnalysisValidationError('output_limit', '/');
  }
  let value: unknown;
  try { value = JSON.parse(json) as unknown; }
  catch { throw new AnalysisValidationError('invalid_json', '/'); }
  return validateWorkItemAnalysis(value, context);
}
