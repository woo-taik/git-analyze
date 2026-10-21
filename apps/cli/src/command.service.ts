import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '@git-analyze/config';
import { collectLocalHistory, PROVIDER_CATALOG } from '@git-analyze/providers';
import { Injectable } from '@nestjs/common';
import { parseCollectOptions } from './collect-options.js';
import { writeHistoryReports } from './history-report.js';

const run = promisify(execFile);

@Injectable()
export class CommandService {
  async run() {
    const [command = 'help', ...extra] = process.argv.slice(2);
    if (command !== 'collect' && extra.length) throw new Error('Unexpected arguments. Use: pnpm cli help');

    switch (command) {
      case 'help':
      case '--help':
        console.log([
          'Git Analyze', '',
          '  pnpm cli doctor     Check local prerequisites',
          '  pnpm cli providers  Show provider integration status',
          '  pnpm cli collect --repo <local-path> [--period 1w|1m|3m|6m] [--ref HEAD] [--path <repo-relative-path>] [--output <new-directory>]',
          '', 'Local committed history only. Remote collection and LLM analysis are not implemented.',
        ].join('\n'));
        return;
      case 'collect': {
        const options = parseCollectOptions(extra);
        const history = await collectLocalHistory(options);
        const files = await writeHistoryReports(history, options.outputDirectory);
        console.log(JSON.stringify({ count: history.commits.length, ...files }, null, 2));
        return;
      }
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
          collectionImplemented: true,
          remoteCollectionImplemented: false,
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
