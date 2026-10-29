import type { Claim, EvidenceReference, ResumeBullet } from './evidence.js';
import { ANALYSIS_CLAIM_FIELDS } from './analysis-schema.js';
import { validateReviewState, type ClaimSection, type ReviewContext, type ReviewState } from './review.js';

export const RESUME_POLICY_VERSION = 'exact-claim-sentence-v1';
export interface TraceableResumeBullet extends ResumeBullet {
  readonly kind: 'achievement' | 'activity';
  readonly clauses: readonly { readonly claimId: string; readonly section: ClaimSection; readonly originalText: string;
    readonly text: string; readonly start: number; readonly end: number; readonly evidence: readonly EvidenceReference[];
    readonly confirmationId: string | null }[];
  readonly completion: ReviewState['completion'];
}

function fail(code: string): never { throw new Error(`Resume output rejected: ${code}`); }
function fragment(claim: Claim): string {
  const text = claim.text.trim().replace(/\s+/g, ' ').replace(/[.!?。]+$/, '');
  if (!text || /[.!?。](?:\s|$)/.test(text)) fail('multiple_sentences_in_claim_edit_first');
  return text;
}

/** An offline composition of existing facts. No new connective language, effects or numbers are invented. */
export function composeResumeBullet(review: ReviewState, context: ReviewContext, claimIds: readonly string[],
  kind: 'achievement' | 'activity' = 'achievement'): TraceableResumeBullet {
  const current = validateReviewState(review, context);
  if (!['achievement', 'activity'].includes(kind) || !claimIds.length || claimIds.length > 8
    || new Set(claimIds).size !== claimIds.length) fail('invalid_selection');
  const all = ANALYSIS_CLAIM_FIELDS.flatMap((section) => current.analysis[section].map((claim) => ({ section, claim })));
  const selected = claimIds.map((id) => {
    const item = all.find(({ claim }) => claim.id === id);
    if (!item || !['source_supported', 'user_confirmed'].includes(item.claim.status)) fail('unknown_or_unconfirmed_claim');
    return item;
  });
  if (!selected.some(({ section }) => section === 'implementation')) fail('implementation_required');
  if (!selected.some(({ section, claim }) => section === 'contribution' && claim.status === 'user_confirmed')) fail('personal_contribution_confirmation_required');
  if (kind === 'achievement' && (current.completion?.status !== 'completed' || !selected.some(({ section }) => section === 'results'))) {
    fail('confirmed_completion_and_result_required');
  }
  let text = '';
  const clauses = selected.map(({ section, claim }) => {
    const clause = fragment(claim);
    if (text) text += '; ';
    const start = text.length;
    text += clause;
    return { claimId: claim.id, section, originalText: claim.text, text: clause, start, end: text.length,
      evidence: claim.evidence, confirmationId: claim.status === 'user_confirmed' ? claim.confirmationId : null };
  });
  text += '.';
  if (text.length > 4096) fail('sentence_too_long');
  return { workItemId: review.workItemId, text, claimIds: [...claimIds], kind, clauses, completion: current.completion };
}
