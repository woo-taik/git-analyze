import { createHash } from 'node:crypto';
import { canonicalJson, type EvidencePacket, type LlmAnalysisRequestOptions } from '@git-analyze/core';

export const TRANSMISSION_POLICY_VERSION = 'analysis-transmission-v1';
export interface AnalysisTransmissionReceipt {
  readonly policyVersion: string;
  readonly sourceInputVersion: string;
  readonly inputVersion: string;
  readonly complete: boolean;
  readonly sentExcerptIds: readonly string[];
  readonly redactedExcerptIds: readonly string[];
  readonly omitted: readonly { readonly id: string; readonly reason: 'not_selected' | 'sensitive_path' | 'empty' }[];
}

// Policy failures contain no source text, paths or redaction values.
export class TransmissionError extends Error {
  constructor(readonly code: 'invalid_selection' | 'invalid_redaction' | 'empty_input' | 'sensitive_content') {
    super(`Analysis transmission blocked: ${code}`);
    this.name = 'TransmissionError';
  }
}

function sensitivePath(path: string | null): boolean {
  if (path === null) return false;
  const parts = path.replaceAll('\\', '/').toLowerCase().split('/');
  const name = parts.at(-1)!;
  return parts.some((part) => ['.ssh', '.aws', '.azure', 'secrets', 'credentials'].includes(part))
    || /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519))$/.test(name)
    || /(?:\.(?:pem|key|p12|pfx)|(?:secrets?|credentials?)\.(?:json|ya?ml|toml))$/.test(name);
}

function sensitiveValue(value: unknown, redactions: readonly string[]): boolean {
  if (typeof value === 'string') return redactions.some((secret) => value.includes(secret))
    || /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}/.test(value);
  if (Array.isArray(value)) return value.some((item) => sensitiveValue(item, redactions));
  if (value && typeof value === 'object') return Object.values(value).some((item) => sensitiveValue(item, redactions));
  return false;
}

export function prepareAnalysisTransmission(packet: EvidencePacket, policy: LlmAnalysisRequestOptions['transmission']) {
  if (!policy || !Array.isArray(policy.allowedExcerptIds)) throw new TransmissionError('invalid_selection');
  const allowed = new Set(policy.allowedExcerptIds);
  const known = new Set(packet.excerpts.map((excerpt) => excerpt.id));
  if (!allowed.size || allowed.size !== policy.allowedExcerptIds.length || [...allowed].some((id) => !known.has(id))) {
    throw new TransmissionError('invalid_selection');
  }
  const values = policy.redactValues ?? [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new TransmissionError('invalid_redaction');
  }
  const redactions = [...new Set(values)].sort((a, b) => b.length - a.length);
  const omitted: AnalysisTransmissionReceipt['omitted'][number][] = [];
  const redactedExcerptIds: string[] = [];
  const excerpts = packet.excerpts.flatMap((excerpt) => {
    const reason = !allowed.has(excerpt.id) ? 'not_selected' : sensitivePath(excerpt.path) ? 'sensitive_path'
      : !excerpt.text.trim() ? 'empty' : null;
    if (reason) { omitted.push({ id: excerpt.id, reason }); return []; }
    let text = excerpt.text;
    for (const value of redactions) text = text.split(value).join('[REDACTED]');
    if (text !== excerpt.text) redactedExcerptIds.push(excerpt.id);
    return [{ ...excerpt, text, complete: excerpt.complete && text === excerpt.text }];
  });
  if (!excerpts.length) throw new TransmissionError('empty_input');
  const complete = packet.complete && !omitted.length && !redactedExcerptIds.length;
  const contributions = packet.provenance.local.commits
    .filter((commit) => excerpts.some((excerpt) => excerpt.commitOid === commit.oid))
    .map((commit) => ({ commitOid: commit.oid, contribution: commit.contribution, decision: commit.decision }));
  const data = { workItemId: packet.workItemId, complete, contributions,
    excerpts: excerpts.map(({ id, reference, text, complete: excerptComplete }) => ({ id, reference, text, complete: excerptComplete })) };
  const inputVersion = createHash('sha256').update(canonicalJson({ policyVersion: TRANSMISSION_POLICY_VERSION,
    sourceInputVersion: packet.version, data })).digest('hex');
  const input = { ...data, inputVersion };
  const serialized = canonicalJson(input);
  // This is a limited fail-closed check, not a general secret detector. Review the allowlist.
  if (sensitiveValue(input, redactions)) throw new TransmissionError('sensitive_content');
  const receipt: AnalysisTransmissionReceipt = { policyVersion: TRANSMISSION_POLICY_VERSION,
    sourceInputVersion: packet.version, inputVersion, complete, sentExcerptIds: excerpts.map((excerpt) => excerpt.id),
    redactedExcerptIds, omitted };
  return { input: serialized, receipt,
    validationPacket: { ...packet, version: inputVersion, complete, excerpts } satisfies EvidencePacket };
}
