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

// An integration contract only: no SDK, credentials or network side effects.
export interface LlmProvider {
  // Model output remains untrusted until validateWorkItemAnalysis succeeds.
  analyze(packet: EvidencePacket, options: LlmRequestOptions): Promise<LlmResult<unknown>>;
  generate(input: {
    readonly analyses: readonly WorkItemAnalysis[];
    readonly language: string;
    readonly maxItems: number;
  }, options: LlmRequestOptions): Promise<LlmResult<readonly ResumeBullet[]>>;
}
