import type { EvidencePacket, LlmAnalysisRequestOptions } from '@git-analyze/core';
import { OPENAI_ANALYSIS_PROMPT_VERSION,
  OPENAI_ANALYSIS_WIRE_SCHEMA_VERSION, prepareClaudeAnalysisRequest, prepareOpenAiAnalysisRequest } from '@git-analyze/providers';
import type { AnalysisSettings } from './analysis-cache.js';

export type AnalysisProviderName = 'claude' | 'openai';
export function providerMetadata(prepared: ReturnType<typeof prepareAnalysisRequest>) {
  return 'promptVersion' in prepared
    ? { provider: 'anthropic', promptVersion: prepared.promptVersion, wireSchemaVersion: prepared.wireSchemaVersion }
    : { provider: 'openai', promptVersion: OPENAI_ANALYSIS_PROMPT_VERSION, wireSchemaVersion: OPENAI_ANALYSIS_WIRE_SCHEMA_VERSION };
}
export function prepareAnalysisRequest(packet: EvidencePacket, settings: AnalysisSettings,
  transmission: LlmAnalysisRequestOptions['transmission'], savedPromptVersion?: string) {
  return settings.provider === 'claude' ? prepareClaudeAnalysisRequest(packet, settings.model, transmission, savedPromptVersion)
    : prepareOpenAiAnalysisRequest(packet, settings.model, transmission);
}
export function generationRequest(prepared: ReturnType<typeof prepareAnalysisRequest>, settings: AnalysisSettings) {
  return settings.provider === 'claude' ? { ...prepared.body, max_tokens: settings.maxOutputTokens, stream: false }
    : { ...prepared.body, max_output_tokens: settings.maxOutputTokens, store: false, stream: false };
}
