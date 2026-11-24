import type { AnalysisJobStore } from '@git-analyze/database';
import { ClaudeAnalysisError, OpenAiAnalysisError, prepareAnalysisSubmission, executeAnalysis } from '@git-analyze/providers';
import type { JobPayload } from '@git-analyze/core';

export function analysisHandler(store: AnalysisJobStore, env: NodeJS.ProcessEnv = process.env, fetch?: typeof globalThis.fetch) {
  return async (payload: JobPayload) => {
    // The job ID is the target; work item identity is loaded from the immutable stored request.
    const queued = await store.queued(payload.targetId, payload.ownerId, payload.repositoryId);
    if (!queued) return;
    const scope = { ownerId: payload.ownerId, repositoryId: payload.repositoryId, workItemId: queued.work_item_id };
    const row = await store.claim(payload.targetId, scope, payload.inputVersion);
    if (!row) return;
    const token = row.lease_token!;
    let outcome: { status: 'succeeded' | 'failed' | 'needs_input'; result: unknown; error: unknown };
    let externalStarted = false;
    try {
      const request = await prepareAnalysisSubmission(row.request, row.request_key);
      const { loaded, prepared, settings, transmission, key } = request;
      if (loaded.bindings.ownerId !== row.owner_id
        || loaded.bindings.repositoryId !== row.repository_id || loaded.bindings.workItemId !== row.work_item_id) throw new Error();
      const apiKey = env[settings.provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'];
      if (!apiKey?.trim()) {
        outcome = { status: 'needs_input', result: null, error: { code: 'provider_key_missing', usage: null } };
      } else {
        externalStarted = true;
        const result = await executeAnalysis(loaded.packet, settings, transmission, apiKey, fetch, request.snapshot.promptVersion);
        outcome = { status: 'succeeded', error: null, result: {
          schemaVersion: 1, status: 'analyzed', createdAt: new Date().toISOString(), source: loaded.source,
          evidence: request.snapshot.evidence, bindings: loaded.bindings, settings, cache: { hit: false, stored: true, key, enabled: true },
          transmission: prepared.receipt, sentInput: JSON.parse(prepared.input) as unknown, result,
        } };
      }
    } catch (error) {
      const known = error instanceof ClaudeAnalysisError || error instanceof OpenAiAnalysisError;
      outcome = { status: externalStarted ? 'needs_input' : 'failed', result: null,
        error: known ? { code: error.code, stage: error.stage, usage: error.usage, httpStatus: error.httpStatus }
          : { code: externalStarted ? 'execution_outcome_unknown' : 'invalid_stored_request', usage: null } };
    }
    // Persistence failure must not be converted into a model failure or another paid execution.
    await store.finish(row.id, token, outcome.status, outcome.result, outcome.error);
  };
}
