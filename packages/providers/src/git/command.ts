import { spawn } from 'node:child_process';

// Every command is read-only and shell-free; ambient Git settings cannot redirect the repository.
export async function readGit(cwd: string, args: readonly string[], maxBytes = 16 * 1024 * 1024, stdin?: string) {
  return new Promise<{ bytes: Buffer; complete: boolean }>((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const child = spawn('git', [
      '--no-pager', '--no-replace-objects', '--no-optional-locks',
      '-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false', ...args,
    ], {
      cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' },
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.stdin.on('error', () => { /* An early command exit can close its input pipe. */ });
    child.stdin.end(stdin);
    const chunks: Buffer[] = [];
    let size = 0;
    let limited = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = maxBytes - size;
      if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); size += Math.min(chunk.length, remaining); }
      if (chunk.length > remaining) { limited = true; child.kill(); }
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Local Git command could not start')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || (!limited && code !== 0)) {
        reject(new Error(`Git ${args[0]} failed or timed out; local objects may be unavailable`));
      } else resolve({ bytes: Buffer.concat(chunks, size), complete: !limited });
    });
  });
}

export async function git(cwd: string, args: readonly string[], maxBytes?: number, stdin?: string): Promise<string> {
  const result = await readGit(cwd, args, maxBytes, stdin);
  if (!result.complete) throw new Error('Git output exceeds the collection limit');
  return result.bytes.toString('utf8');
}
