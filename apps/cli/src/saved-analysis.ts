import { resolve } from 'node:path';
import { canonicalJson } from '@git-analyze/core';
import { prepareOpenAiAnalysisRequest, type AnalysisTransmissionReceipt } from '@git-analyze/providers';
import { analysisCacheKey, hash, validateAnalysisResult, type AnalysisSettings } from './analysis-cache.js';
import { identity, object, parseAnalysisInput, readBoundedJson } from './analysis-input.js';

// Check an already sanitized snapshot without needing to retain the secret values used to mask it.
function maskedFrom(original: string, masked: string): boolean {
  const parts = masked.split('[REDACTED]');
  if (parts.length < 2 || parts.length > 10_000 || !original.startsWith(parts[0]!)) return false;
  let offset = parts[0]!.length;
  for (let index = 1; index < parts.length; index++) {
    const part = parts[index]!;
    const next = index === parts.length - 1 ? original.length - part.length : original.indexOf(part, offset + 1);
    if (next <= offset || !original.startsWith(part, next)) return false;
    offset = next + part.length;
  }
  return offset === original.length;
}

export async function loadSavedAnalysis(path: string) {
  const analysisFile = resolve(path);
  const report = object(await readBoundedJson(analysisFile, 32 * 1024 * 1024));
  if (report.schemaVersion !== 1 || report.status !== 'analyzed') throw new Error('Expected a successful analysis report');
  const source = object(report.source);
  if (typeof source.inputFile !== 'string') throw new Error('Missing original evidence file');
  const loaded = await parseAnalysisInput(await readBoundedJson(source.inputFile, 32 * 1024 * 1024), report.bindings, source.inputFile);
  if (canonicalJson(source) !== canonicalJson(loaded.source)) throw new Error('Saved analysis source does not match original evidence');
  const rawSettings = object(report.settings);
  const settings: AnalysisSettings = { model: identity(rawSettings.model), modelEpoch: identity(rawSettings.modelEpoch),
    contextWindowTokens: positive(rawSettings.contextWindowTokens), maxInputTokens: positive(rawSettings.maxInputTokens),
    maxOutputTokens: positive(rawSettings.maxOutputTokens), timeoutMs: positive(rawSettings.timeoutMs) };
  if (settings.timeoutMs > 60_000) throw new Error('Invalid saved analysis timeout');
  const receipt = object(report.transmission);
  const sent = object(report.sentInput);
  if (!Array.isArray(sent.excerpts) || sent.excerpts.length > 120 || !Array.isArray(receipt.redactedExcerptIds)
    || receipt.redactedExcerptIds.some((id) => typeof id !== 'string')
    || new Set(receipt.redactedExcerptIds).size !== receipt.redactedExcerptIds.length) throw new Error('Invalid saved transmission');
  const redacted = new Set<string>(receipt.redactedExcerptIds as string[]);
  const selected = new Set<string>();
  const packet = structuredClone(loaded.packet);
  for (const value of sent.excerpts) {
    const excerpt = object(value);
    if (typeof excerpt.id !== 'string' || typeof excerpt.text !== 'string' || typeof excerpt.complete !== 'boolean'
      || selected.has(excerpt.id)) throw new Error('Invalid or duplicate saved excerpt');
    selected.add(excerpt.id);
    const original = packet.excerpts.find((item) => item.id === excerpt.id);
    if (!original || canonicalJson(excerpt.reference) !== canonicalJson(original.reference)) throw new Error('Unknown saved excerpt reference');
    if (redacted.has(excerpt.id)) {
      if (excerpt.complete || excerpt.text === original.text || !maskedFrom(original.text, excerpt.text)) throw new Error('Invalid saved masking');
    } else if (excerpt.text !== original.text || excerpt.complete !== original.complete) throw new Error('Saved excerpt differs from source');
    Object.assign(original, { text: excerpt.text, complete: excerpt.complete });
  }
  if ([...redacted].some((id) => !selected.has(id))) throw new Error('Unknown saved redaction');
  // The same pure request builder verifies sensitive-path exclusions, contribution mapping and transmission hashes.
  const prepared = prepareOpenAiAnalysisRequest({ ...packet, complete: packet.complete && !redacted.size }, settings.model,
    { allowedExcerptIds: [...selected] });
  const omittedSelections = object(object(report.result).request).transmission;
  if (canonicalJson(omittedSelections) !== canonicalJson(receipt)) throw new Error('Inconsistent saved transmission receipts');
  // A requested sensitive path and an unselected sensitive path have different receipt reasons. Neither was sent.
  const omitted = receipt.omitted;
  if (!Array.isArray(omitted) || omitted.length !== prepared.receipt.omitted.length) throw new Error('Invalid saved omissions');
  const sensitiveIds = omitted.filter((value) => ['sensitive_path', 'empty'].includes(String(object(value).reason))).map((value) => object(value).id);
  const withSensitive = prepareOpenAiAnalysisRequest({ ...packet, complete: packet.complete && !redacted.size }, settings.model,
    { allowedExcerptIds: [...selected, ...sensitiveIds.map(identity)] });
  const restoredReceipt = { ...withSensitive.receipt, redactedExcerptIds: [...redacted] };
  if (canonicalJson(restoredReceipt) !== canonicalJson(receipt) || withSensitive.input !== canonicalJson(sent)) {
    throw new Error('Saved transmission version or payload does not match');
  }
  const restored = { ...withSensitive, receipt: restoredReceipt as AnalysisTransmissionReceipt };
  const result = validateAnalysisResult(report.result, restored, settings);
  if (object(report.cache).key !== analysisCacheKey(restored, settings)) throw new Error('Saved analysis cache identity does not match');
  const baseline = { packet: restored.validationPacket, analysis: result.value };
  return { analysisFile, ...loaded, baseline, analysisVersion: hash({ ownerId: packet.ownerId, repositoryId: packet.repositoryId,
    workItemId: packet.workItemId, inputVersion: baseline.packet.version, analysis: baseline.analysis }) };
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('Invalid saved analysis budget');
  return value as number;
}
