import type { EvidencePacket, ResumeBullet, WorkItemAnalysis } from './evidence.js';

export interface LlmUsage {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number | null;
  readonly requestId: string | null;
}

export interface LlmResult<T> {
  readonly value: T;
  readonly usage: LlmUsage;
}

export interface LlmRequestOptions {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

export interface LlmAnalysisRequestOptions extends LlmRequestOptions {
  readonly transmission: {
    // Explicitly reviewed excerpts; token counting also sends these to the provider.
    readonly allowedExcerptIds: readonly string[];
    readonly redactValues?: readonly string[];
  };
}

export interface LlmAnalysisProvider {
  // Raw provider output is unknown until validated by the adapter/application.
  analyze(packet: EvidencePacket, options: LlmAnalysisRequestOptions): Promise<LlmResult<unknown>>;
}

// An integration contract only: no SDK, credentials or network side effects.
export interface LlmProvider extends LlmAnalysisProvider {
  generate(input: {
    readonly analyses: readonly WorkItemAnalysis[];
    readonly language: string;
    readonly maxItems: number;
  }, options: LlmRequestOptions): Promise<LlmResult<readonly ResumeBullet[]>>;
}
