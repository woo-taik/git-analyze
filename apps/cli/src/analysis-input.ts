import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { toEvidencePacket, validateLocalEvidencePacket, type EvidenceSourceBinding } from '@git-analyze/core';

export async function readBoundedJson(path: string, maxBytes: number): Promise<unknown> {
  try {
    const handle = await open(path, 'r');
    let data: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) throw new Error();
      const chunks: Buffer[] = [];
      let length = 0;
      while (true) {
        const chunk = Buffer.alloc(Math.min(65_536, maxBytes + 1 - length));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        length += bytesRead;
        if (length > maxBytes) throw new Error();
        chunks.push(chunk.subarray(0, bytesRead));
      }
      data = Buffer.concat(chunks, length);
    } finally { await handle.close(); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as unknown;
  } catch { throw new Error(`Cannot read valid UTF-8 JSON within ${maxBytes} bytes`); }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid analysis input object');
  return value as Record<string, unknown>;
}
export function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error('Invalid analysis identity');
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Invalid analysis input timestamp');
  }
  return value;
}

export async function loadAnalysisInput(inputPath: string, bindingsPath: string) {
  const inputFile = resolve(inputPath);
  const report = object(await readBoundedJson(inputFile, 32 * 1024 * 1024));
  if (report.schemaVersion !== 1 || typeof report.contentVersion !== 'string' || !/^[a-f0-9]{64}$/.test(report.contentVersion)) {
    throw new Error('Unsupported evidence report schema or content version');
  }
  timestamp(report.createdAt);
  const source = object(report.source);
  if (typeof source.inputFile !== 'string' || typeof source.repositoryPath !== 'string' || !source.repositoryPath.trim()
    || typeof source.tipOid !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.tipOid)
    || (source.ref !== undefined && (typeof source.ref !== 'string' || !source.ref.trim()))) {
    throw new Error('Invalid evidence report source');
  }
  const startAt = timestamp(source.startAt);
  const endAt = timestamp(source.endAt);
  if (Date.parse(startAt) >= Date.parse(endAt)) throw new Error('Invalid evidence report period');
  const packet = validateLocalEvidencePacket(report.packet);
  if (packet.commits.some((commit) => Date.parse(commit.committedAt) < Date.parse(startAt)
    || Date.parse(commit.committedAt) >= Date.parse(endAt))) {
    throw new Error('Evidence commit is outside the declared report period');
  }
  const bindings = object(await readBoundedJson(resolve(bindingsPath), 1_048_576));
  if (bindings.schemaVersion !== 1 || !Array.isArray(bindings.sources) || bindings.sources.length > 20) {
    throw new Error('Unsupported source bindings schema');
  }
  const scope = { ownerId: identity(bindings.ownerId), repositoryId: identity(bindings.repositoryId),
    workItemId: identity(bindings.workItemId) };
  const sources: EvidenceSourceBinding[] = bindings.sources.map((value) => {
    const source = object(value);
    const commitOid = identity(source.commitOid);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitOid)) throw new Error('Invalid source commit OID');
    return { ownerId: identity(source.ownerId), repositoryId: identity(source.repositoryId), commitOid,
      sourceRecordId: identity(source.sourceRecordId), sourceVersion: identity(source.sourceVersion) };
  });
  const mapped = await toEvidencePacket({ ...scope, packet, contentVersion: report.contentVersion, sources });
  return { packet: mapped, bindings: { schemaVersion: 1, ...scope, sources }, source: {
    inputFile, contentVersion: report.contentVersion, repositoryPath: source.repositoryPath,
    ref: source.ref ?? null, tipOid: source.tipOid, startAt, endAt,
    commitCount: packet.commits.length, pathFilter: packet.pathFilter,
  } };
}
