import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '@git-analyze/config';
import { PROVIDER_CATALOG } from '@git-analyze/providers';
import { Injectable } from '@nestjs/common';

const run = promisify(execFile);

@Injectable()
export class CommandService {
  async run() {
    const [command = 'help', ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('Unexpected arguments. Use: pnpm cli help');

    switch (command) {
      case 'help':
      case '--help':
        console.log('Git Analyze\n\n  pnpm cli doctor     Check local prerequisites\n  pnpm cli providers  Show planned provider integrations\n\nCollection and LLM analysis are not implemented yet.');
        return;
      case 'providers':
        console.log(JSON.stringify({ providers: PROVIDER_CATALOG }, null, 2));
        return;
      case 'doctor': {
        const config = loadConfig();
        let git: string | null = null;
        try {
          git = (await run('git', ['--version'], { timeout: 5_000 })).stdout.trim();
        } catch {
          // Only report availability; command failures may include sensitive context.
        }
        console.log(JSON.stringify({
          node: process.version,
          git,
          database: { configured: Boolean(config.databaseUrl), connectionTested: false },
          collectionImplemented: false,
          llmImplemented: false,
        }, null, 2));
        if (!git) process.exitCode = 1;
        return;
      }
      default:
        throw new Error('Unknown command. Use: pnpm cli help');
    }
  }
}
