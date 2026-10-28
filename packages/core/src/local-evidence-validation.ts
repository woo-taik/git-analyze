import { Ajv } from 'ajv';
import { EXTRACTION_VERSION, utf8Bytes, type LocalEvidencePacket } from './evidence-extraction.js';

const string = { type: 'string' };
const identity = { type: 'string', minLength: 1, maxLength: 512, pattern: '\\S' };
const oid = { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' };
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const array = (items: object, maxItems: number, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const object = (properties: Record<string, object>) => ({
  type: 'object', additionalProperties: false, required: Object.keys(properties), properties,
});
const integer = (maximum: number, minimum = 0) => ({ type: 'integer', minimum, maximum });
const path = { type: 'string', minLength: 1, maxLength: 16_384 };
const excerptId = { type: 'string', minLength: 1, maxLength: 65_536 };
const person = object({ name: string, email: string });
const timestamp = { type: 'string', maxLength: 64, pattern: 'T.*(?:Z|[+-]\\d{2}:\\d{2})$' };
const reason = { enum: ['low_priority', 'file_limit', 'total_budget', 'file_budget', 'binary', 'non_utf8', 'submodule', 'unavailable'] };
const schema = object({
  schemaVersion: { const: 1 }, extractionVersion: { const: EXTRACTION_VERSION }, repositoryScope: identity,
  pathFilter: nullable(path),
  selection: object({ kind: { enum: ['group', 'manual'] }, title: string, groupId: nullable(identity),
    commitOids: { ...array(oid, 20, 1), uniqueItems: true } }),
  limits: object({ maxFileBytes: integer(262_144, 1), maxTotalBytes: integer(1_048_576, 1),
    maxFiles: integer(100, 1), includeLowPriority: { type: 'boolean' } }),
  complete: { type: 'boolean' },
  commits: array(object({ oid, parentOid: nullable(oid), available: { type: 'boolean' }, author: person, committer: person,
    authoredAt: timestamp, committedAt: timestamp,
    contribution: { enum: ['author', 'co_author', 'committer_only', 'none'] }, decision: { enum: ['candidate', 'review'] },
    reasons: array({ enum: ['author_matched', 'co_author_trailer', 'committer_only', 'identity_not_matched', 'merge_commit',
      'low_priority_files_only', 'no_file_changes', 'multiple_issue_references', 'manual_include', 'manual_exclude'] }, 32),
    issues: array(identity, 100),
    files: array(object({ path, status: { type: 'string', pattern: '^[A-Z]$' },
      oldMode: { type: 'string', pattern: '^[0-7]{6}$' }, newMode: { type: 'string', pattern: '^[0-7]{6}$' },
      oldOid: oid, newOid: oid, excerptId: nullable(excerptId), reason: nullable(reason) }), 100_000),
  }), 20, 1),
  excerpts: array(object({ id: excerptId, commitOid: oid, parentOid: nullable(oid),
    path: nullable(path), locator: identity, text: string, complete: { type: 'boolean' } }), 120),
  summary: object({ excerptBytes: integer(1_048_576), files: integer(2_000_000), patchExcerpts: integer(100),
    omittedOrPartialFiles: integer(2_000_000) }),
});
const check = new Ajv({ strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false })
  .compile<LocalEvidencePacket>(schema);

function fail(): never { throw new Error('Invalid local evidence packet'); }
function validPath(value: string): boolean {
  return !value.includes('\0') && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
    && !value.split('/').some((part) => part === '..' || part === '.' || !part);
}

/** Structural validation for decoded, untrusted file input. The mapper additionally checks hashes and links. */
export function validateLocalEvidencePacket(value: unknown): LocalEvidencePacket {
  if (!check(value)) fail();
  if (value.pathFilter !== null && !validPath(value.pathFilter)) fail();
  if ((value.selection.kind === 'group') !== (value.selection.groupId !== null)) fail();
  const files = value.commits.flatMap((commit) => commit.files);
  const excerpts = new Map(value.excerpts.map((excerpt) => [excerpt.id, excerpt]));
  const patches = value.excerpts.filter((excerpt) => excerpt.path !== null);
  const bytes = value.excerpts.reduce((sum, excerpt) => sum + utf8Bytes(excerpt.text), 0);
  if (bytes !== value.summary.excerptBytes || bytes > value.limits.maxTotalBytes
    || files.length !== value.summary.files || patches.length !== value.summary.patchExcerpts
    || patches.length > value.limits.maxFiles
    || files.filter((file) => file.reason !== null).length !== value.summary.omittedOrPartialFiles) fail();
  for (const commit of value.commits) {
    if (!Number.isFinite(Date.parse(commit.authoredAt)) || !Number.isFinite(Date.parse(commit.committedAt))) fail();
    if (!commit.available && (commit.files.length || value.excerpts.some((excerpt) => excerpt.commitOid === commit.oid))) fail();
    if (commit.available && value.excerpts.filter((excerpt) => excerpt.commitOid === commit.oid && excerpt.path === null).length !== 1) fail();
    if (new Set(commit.files.map((file) => file.path)).size !== commit.files.length) fail();
    for (const file of commit.files) {
      if (!validPath(file.path) || (value.pathFilter !== null && file.path !== value.pathFilter
        && !file.path.startsWith(`${value.pathFilter}/`))) fail();
      const excerpt = file.excerptId === null ? undefined : excerpts.get(file.excerptId);
      if (excerpt && (utf8Bytes(excerpt.text) > value.limits.maxFileBytes || (file.reason !== null && excerpt.complete))) fail();
    }
  }
  for (const excerpt of value.excerpts) {
    if (excerpt.path === null) {
      if (excerpt.id !== `git:${excerpt.commitOid}:message` || excerpt.locator !== 'commit-message'
        || utf8Bytes(excerpt.text) > 4_096) fail();
    } else {
      const lines = excerpt.text.split('\n').length - (excerpt.text.endsWith('\n') ? 1 : 0);
      if (!excerpt.text || excerpt.id !== `git:${excerpt.commitOid}:${encodeURIComponent(excerpt.path)}:patch:1-${lines}`
        || excerpt.locator !== `first-parent-patch-lines:1-${lines}`) fail();
    }
  }
  return structuredClone(value);
}
