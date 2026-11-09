import type { EvidencePacket, LlmAnalysisRequestOptions } from '@git-analyze/core';
import { CLAUDE_ANALYSIS_PROMPT_VERSION, CLAUDE_ANALYSIS_WIRE_SCHEMA_VERSION, OPENAI_ANALYSIS_PROMPT_VERSION,
  OPENAI_ANALYSIS_WIRE_SCHEMA_VERSION, prepareClaudeAnalysisRequest, prepareOpenAiAnalysisRequest } from '@git-analyze/providers';
import type { AnalysisSettings } from './analysis-cache.js';

export type AnalysisProviderName = 'claude' | 'openai';
export function providerMetadata(settings: AnalysisSettings) {
  return settings.provider === 'claude'
    ? { provider: 'anthropic', promptVersion: CLAUDE_ANALYSIS_PROMPT_VERSION, wireSchemaVersion: CLAUDE_ANALYSIS_WIRE_SCHEMA_VERSION }
    : { provider: 'openai', promptVersion: OPENAI_ANALYSIS_PROMPT_VERSION, wireSchemaVersion: OPENAI_ANALYSIS_WIRE_SCHEMA_VERSION };
}
export function prepareAnalysisRequest(packet: EvidencePacket, settings: AnalysisSettings, transmission: LlmAnalysisRequestOptions['transmission']) {
  return settings.provider === 'claude' ? prepareClaudeAnalysisRequest(packet, settings.model, transmission)
    : prepareOpenAiAnalysisRequest(packet, settings.model, transmission);
}
export function generationRequest(prepared: ReturnType<typeof prepareAnalysisRequest>, settings: AnalysisSettings) {
  return settings.provider === 'claude' ? { ...prepared.body, max_tokens: settings.maxOutputTokens, stream: false }
    : { ...prepared.body, max_output_tokens: settings.maxOutputTokens, store: false, stream: false };
}
