import type { EvidencePacket, LlmAnalysisRequestOptions } from '@git-analyze/core';
import { ClaudeAnalysisProvider } from './claude-analysis.js';
import { OpenAiAnalysisProvider } from './openai-analysis.js';
import { object, identity } from './analysis-input.js';
import { validateAnalysisResult, type AnalysisSettings } from './analysis-contract.js';
import { prepareAnalysisRequest } from './analysis-runtime.js';

export function parseAnalysisSettings(value: unknown): AnalysisSettings {
  const raw = object(value);
  if (raw.provider !== 'claude' && raw.provider !== 'openai') throw new Error('Invalid provider');
  const positive = (name: string, max = Number.MAX_SAFE_INTEGER) => {
    const n = raw[name];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('Invalid analysis budget');
    return n;
  };
  const settings: AnalysisSettings = { provider: raw.provider, model: identity(raw.model), modelEpoch: identity(raw.modelEpoch),
    contextWindowTokens: positive('contextWindowTokens'), maxInputTokens: positive('maxInputTokens'),
    maxOutputTokens: positive('maxOutputTokens'), timeoutMs: positive('timeoutMs', 60_000) };
  if (settings.maxOutputTokens > settings.contextWindowTokens) throw new Error('Invalid output reservation');
  return settings;
}
export async function executeAnalysis(packet: EvidencePacket, settings: AnalysisSettings,
  transmission: LlmAnalysisRequestOptions['transmission'], apiKey: string, fetch?: typeof globalThis.fetch) {
  const prepared = prepareAnalysisRequest(packet, settings, transmission);
  const Provider = settings.provider === 'claude' ? ClaudeAnalysisProvider : OpenAiAnalysisProvider;
  const provider = new Provider({ apiKey, model: settings.model, contextWindowTokens: settings.contextWindowTokens,
    timeoutMs: settings.timeoutMs }, fetch ? { fetch } : {});
  return validateAnalysisResult(await provider.analyze(packet, { maxInputTokens: settings.maxInputTokens,
    maxOutputTokens: settings.maxOutputTokens, transmission }), prepared, settings);
}
