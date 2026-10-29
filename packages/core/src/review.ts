import { Ajv } from 'ajv';
import { ANALYSIS_CLAIM_FIELDS } from './analysis-schema.js';
import { validateWorkItemAnalysis } from './analysis-validation.js';
import type { Claim, ClaimConfirmation, EvidencePacket, EvidenceReference, WorkItemAnalysis } from './evidence.js';

export const REVIEW_POLICY_VERSION = 'local-review-v1';
export type ClaimSection = (typeof ANALYSIS_CLAIM_FIELDS)[number];
export type ReviewAction =
  | { readonly kind: 'answer'; readonly section: ClaimSection; readonly claimId: string; readonly text: string; readonly question: string | null }
  | { readonly kind: 'edit'; readonly claimId: string; readonly text: string }
  | { readonly kind: 'confirm'; readonly claimId: string; readonly text: string }
  | { readonly kind: 'revoke'; readonly confirmationId: string }
  | { readonly kind: 'completion'; readonly status: 'completed' | 'in_progress' | 'unknown'; readonly completedAt: string | null; readonly note: string };
export interface ReviewEvent {
  readonly id: string;
  readonly actor: string;
  readonly recordedAt: string;
  readonly analysisVersion: string;
  readonly action: ReviewAction | { readonly kind: 'rebase' };
}
export interface ReviewState {
  readonly policyVersion: typeof REVIEW_POLICY_VERSION;
  readonly ownerId: string;
  readonly repositoryId: string;
  readonly workItemId: string;
  readonly analysisVersion: string;
  readonly analysis: WorkItemAnalysis;
  readonly confirmations: readonly ClaimConfirmation[];
  readonly answers: readonly { readonly claimId: string; readonly question: string | null }[];
  readonly questions: readonly string[];
  readonly completion: { readonly status: 'completed' | 'in_progress' | 'unknown'; readonly completedAt: string | null;
    readonly note: string; readonly eventId: string } | null;
  readonly events: readonly ReviewEvent[];
}
export interface ReviewContext {
  readonly packet: EvidencePacket;
  readonly analysis: WorkItemAnalysis;
  readonly analysisVersion: string;
}

const id = { type: 'string', minLength: 1, maxLength: 512, pattern: '\\S' };
const text = { type: 'string', minLength: 1, maxLength: 4096, pattern: '\\S' };
const version = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const nullable = (value: object) => ({ anyOf: [value, { type: 'null' }] });
const object = (properties: Record<string, object>) => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false });
const list = (items: object, maxItems: number) => ({ type: 'array', items, maxItems });
const actionSchemas = [
  object({ kind: { const: 'answer' }, section: { enum: ANALYSIS_CLAIM_FIELDS }, claimId: id, text, question: nullable(text) }),
  object({ kind: { const: 'edit' }, claimId: id, text }),
  object({ kind: { const: 'confirm' }, claimId: id, text }),
  object({ kind: { const: 'revoke' }, confirmationId: id }),
  object({ kind: { const: 'completion' }, status: { enum: ['completed', 'in_progress', 'unknown'] }, completedAt: nullable(id), note: text }),
];
const ajv = new Ajv({ strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
const checkActions = ajv.compile<{ schemaVersion: 1; actions: ReviewAction[] }>(object({ schemaVersion: { const: 1 },
  actions: { ...list({ anyOf: actionSchemas }, 100), minItems: 1 } }));
const checkState = ajv.compile<ReviewState>(object({ policyVersion: { const: REVIEW_POLICY_VERSION },
  ownerId: id, repositoryId: id, workItemId: id, analysisVersion: version, analysis: { type: 'object' },
  confirmations: list(object({ id, ownerId: id, repositoryId: id, workItemId: id, inputVersion: version,
    claimId: id, text, status: { enum: ['confirmed', 'revoked'] } }), 1000),
  answers: list(object({ claimId: id, question: nullable(text) }), 256), questions: list(text, 20),
  completion: nullable(object({ status: { enum: ['completed', 'in_progress', 'unknown'] }, completedAt: nullable(id), note: text, eventId: id })),
  events: list(object({ id, actor: id, recordedAt: id, analysisVersion: version,
    action: { anyOf: [...actionSchemas, object({ kind: { const: 'rebase' } })] } }), 1000),
}));

function fail(code: string): never { throw new Error(`Review rejected: ${code}`); }
const claims = (analysis: WorkItemAnalysis) => ANALYSIS_CLAIM_FIELDS.flatMap((section) => analysis[section].map((claim) => ({ section, claim })));
const validDate = (value: string) => /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const referenceKey = (value: EvidenceReference) => JSON.stringify([value.sourceRecordId, value.sourceVersion, value.locator]);

export function parseReviewChanges(value: unknown): readonly ReviewAction[] {
  if (!checkActions(value)) fail('invalid_changes');
  return structuredClone(value.actions);
}

export function createReviewState(context: ReviewContext): ReviewState {
  const analysis = validateWorkItemAnalysis(context.analysis, { packet: context.packet });
  return { policyVersion: REVIEW_POLICY_VERSION, ownerId: context.packet.ownerId, repositoryId: context.packet.repositoryId,
    workItemId: context.packet.workItemId, analysisVersion: context.analysisVersion, analysis, confirmations: [], answers: [],
    questions: [...analysis.missingQuestions], completion: null, events: [] };
}

export function validateReviewState(value: unknown, context: ReviewContext): ReviewState {
  if (!checkState(value)) fail('invalid_state');
  if (value.ownerId !== context.packet.ownerId || value.repositoryId !== context.packet.repositoryId
    || value.workItemId !== context.packet.workItemId || value.analysisVersion !== context.analysisVersion) fail('scope_or_analysis_mismatch');
  if (JSON.stringify(value.questions) !== JSON.stringify(context.analysis.missingQuestions)) fail('question_mismatch');
  const events = new Map(value.events.map((event) => [event.id, event]));
  if (events.size !== value.events.length || value.events.some((event) => !validDate(event.recordedAt))) fail('invalid_event_history');
  const confirmations = new Map(value.confirmations.map((record) => [record.id, record]));
  if (confirmations.size !== value.confirmations.length) fail('duplicate_confirmation');
  for (const record of value.confirmations) {
    const event = events.get(record.id);
    if (!event || event.action.kind !== 'confirm' || event.action.claimId !== record.claimId || event.action.text !== record.text
      || record.ownerId !== value.ownerId || record.repositoryId !== value.repositoryId || record.workItemId !== value.workItemId) fail('invalid_confirmation_history');
    if (record.status === 'confirmed' && (record.inputVersion !== context.packet.version || event.analysisVersion !== value.analysisVersion)) fail('stale_confirmation');
  }
  const analysis = validateWorkItemAnalysis(value.analysis, { packet: context.packet, confirmations: value.confirmations });
  const all = claims(analysis);
  if (new Set(value.answers.map((answer) => answer.claimId)).size !== value.answers.length
    || value.answers.some((answer) => !all.some(({ claim }) => claim.id === answer.claimId))) fail('invalid_answers');
  for (const record of value.confirmations.filter((record) => record.status === 'confirmed')) {
    if (!all.some(({ claim }) => claim.id === record.claimId && claim.status === 'user_confirmed' && claim.confirmationId === record.id)) fail('orphan_confirmation');
  }
  if (value.completion) {
    const event = events.get(value.completion.eventId);
    if (!event || event.analysisVersion !== value.analysisVersion || event.action.kind !== 'completion'
      || event.action.status !== value.completion.status || event.action.completedAt !== value.completion.completedAt
      || event.action.note !== value.completion.note) fail('invalid_completion_history');
    validateCompletion(value.completion);
  }
  const unresolved = value.questions.filter((question) => !value.answers.some((answer) => answer.question === question
    && all.some(({ claim }) => claim.id === answer.claimId && claim.status === 'user_confirmed')));
  if (JSON.stringify(analysis.missingQuestions) !== JSON.stringify(unresolved)) fail('invalid_unresolved_questions');
  return structuredClone({ ...value, analysis });
}

function validateCompletion(action: { status: string; completedAt: string | null }) {
  if (action.status === 'completed' ? action.completedAt === null || !validDate(action.completedAt) : action.completedAt !== null) fail('invalid_completion_date');
}

export function applyReviewChanges(input: ReviewState, changes: readonly ReviewAction[], context: ReviewContext,
  metadata: { readonly actor: string; readonly recordedAt: string }): ReviewState {
  const initial = validateReviewState(input, context);
  if (!metadata.actor.trim() || metadata.actor.length > 512 || !validDate(metadata.recordedAt)) fail('invalid_actor_or_time');
  const actions = parseReviewChanges({ schemaVersion: 1, actions: changes });
  // Work on detached mutable state; a rejected batch never changes the persisted input.
  const analysis = structuredClone(initial.analysis) as { -readonly [K in keyof WorkItemAnalysis]: WorkItemAnalysis[K] };
  const confirmations = initial.confirmations.map((record) => ({ ...record }));
  const answers = [...initial.answers];
  const events = [...initial.events];
  let completion = initial.completion;
  const replace = (section: ClaimSection, claim: Claim) => { analysis[section] = analysis[section].map((item) => item.id === claim.id ? claim : item); };
  for (const action of actions) {
    const event: ReviewEvent = { id: crypto.randomUUID(), actor: metadata.actor, recordedAt: metadata.recordedAt,
      analysisVersion: context.analysisVersion, action };
    const target = 'claimId' in action ? claims(analysis).find(({ claim }) => claim.id === action.claimId) : undefined;
    if (action.kind === 'answer') {
      if (target || (action.question !== null && !initial.questions.includes(action.question))) fail('duplicate_claim_or_unknown_question');
      analysis[action.section] = [...analysis[action.section], { id: action.claimId, text: action.text, status: 'inferred', evidence: [] }];
      answers.push({ claimId: action.claimId, question: action.question });
    } else if (action.kind === 'edit') {
      if (!target) fail('unknown_claim');
      for (const record of confirmations) if (record.claimId === action.claimId && record.status === 'confirmed') record.status = 'revoked';
      replace(target.section, { id: target.claim.id, text: action.text, status: 'inferred', evidence: target.claim.evidence });
    } else if (action.kind === 'confirm') {
      if (!target || target.claim.text !== action.text) fail('confirmation_text_mismatch');
      if (target.claim.status === 'user_confirmed') fail('already_confirmed');
      confirmations.push({ id: event.id, ownerId: initial.ownerId, repositoryId: initial.repositoryId,
        workItemId: initial.workItemId, inputVersion: context.packet.version, claimId: action.claimId, text: action.text, status: 'confirmed' });
      replace(target.section, { id: action.claimId, text: action.text, status: 'user_confirmed', evidence: target.claim.evidence, confirmationId: event.id });
    } else if (action.kind === 'revoke') {
      const record = confirmations.find((record) => record.id === action.confirmationId);
      if (!record || record.status !== 'confirmed') fail('unknown_or_inactive_confirmation');
      record.status = 'revoked';
      const current = claims(analysis).find(({ claim }) => claim.status === 'user_confirmed' && claim.confirmationId === record.id);
      if (current) replace(current.section, { id: current.claim.id, text: current.claim.text, status: 'inferred', evidence: current.claim.evidence });
    } else {
      validateCompletion(action);
      completion = { status: action.status, completedAt: action.completedAt, note: action.note, eventId: event.id };
    }
    events.push(event);
  }
  analysis.missingQuestions = initial.questions.filter((question) => !answers.some((answer) => answer.question === question
    && claims(analysis).some(({ claim }) => claim.id === answer.claimId && claim.status === 'user_confirmed')));
  return validateReviewState({ ...initial, analysis, confirmations, answers, events, completion }, context);
}

/** Keep user edits as unconfirmed drafts on a changed analysis; never carry approval or completion across versions. */
export function rebaseReviewState(previous: ReviewState, context: ReviewContext, metadata: { actor: string; recordedAt: string }): ReviewState {
  if (previous.ownerId !== context.packet.ownerId || previous.repositoryId !== context.packet.repositoryId || previous.workItemId !== context.packet.workItemId) fail('rebase_scope_mismatch');
  const fresh = createReviewState(context);
  const edited = new Set(previous.events.flatMap((event) => event.action.kind === 'edit' || event.action.kind === 'answer' ? [event.action.claimId] : []));
  const analysis = structuredClone(fresh.analysis) as { -readonly [K in keyof WorkItemAnalysis]: WorkItemAnalysis[K] };
  const references = new Set(context.packet.excerpts.map((excerpt) => referenceKey(excerpt.reference)));
  for (const { section, claim } of claims(previous.analysis).filter(({ claim }) => edited.has(claim.id))) {
    const target = claims(analysis).find((item) => item.claim.id === claim.id);
    if (target && target.section !== section) fail('rebase_claim_section_conflict');
    const draft: Claim = { id: claim.id, text: claim.text, status: 'inferred', evidence: claim.evidence.filter((ref) => references.has(referenceKey(ref))) };
    analysis[section] = target ? analysis[section].map((item) => item.id === claim.id ? draft : item) : [...analysis[section], draft];
  }
  const events = [...previous.events, { id: crypto.randomUUID(), ...metadata, analysisVersion: context.analysisVersion, action: { kind: 'rebase' as const } }];
  return validateReviewState({ ...fresh, analysis, events, answers: previous.answers,
    confirmations: previous.confirmations.map((record) => ({ ...record, status: 'revoked' })) }, context);
}
