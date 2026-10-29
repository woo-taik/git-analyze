import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '@git-analyze/config';
import { collectLocalHistory, PROVIDER_CATALOG } from '@git-analyze/providers';
import { Injectable } from '@nestjs/common';
import { parseCollectOptions } from './collect-options.js';
import { writeHistoryReports } from './history-report.js';
import { executePrepare } from './prepare.js';
import { executeEvidence } from './evidence.js';
import { executeAnalyze } from './analyze.js';
import { executeReview } from './review.js';
import { executeResume } from './resume.js';

const run = promisify(execFile);

@Injectable()
export class CommandService {
  async run() {
    const [command = 'help', ...extra] = process.argv.slice(2);
    if (!['collect', 'prepare', 'evidence', 'analyze', 'review', 'resume'].includes(command) && extra.length) throw new Error('Unexpected arguments. Use: pnpm cli help');

    switch (command) {
      case 'help':
      case '--help':
        console.log([
          'Git Analyze', '',
          '  pnpm cli doctor     Check local prerequisites',
          '  pnpm cli providers  Show provider integration status',
          '  pnpm cli collect --repo <local-path> [--period 1w|1m|3m|6m] [--ref HEAD] [--path <repo-relative-path>] [--output <new-directory>]',
          '  pnpm cli prepare --input <history.json> --author <email> [--alias <email>] [--include <full-oid>] [--exclude <full-oid>] [--output <new-directory>]',
          '  pnpm cli evidence --input <candidates.json> (--group <id> | --commit <full-oid>...) [--title <text>] [--repo <local-path>] [--output <new-directory>]',
          '    [--max-file-bytes 16384] [--max-total-bytes 65536] [--max-files 20] [--include-low-priority] [--cache-dir <path>] [--no-cache]',
          '  pnpm cli analyze --input <evidence.json> --bindings <bindings.json> --excerpt <reviewed-id>...',
          '    --model <model> --model-epoch <revision-or-epoch> --context-window <tokens>',
          '    [--max-input-tokens 8000] [--max-output-tokens 1000] [--timeout-ms 30000]',
          '    [--redactions-file <json-array>] [--dry-run] [--cache-dir <path>] [--no-cache] [--output <new-directory>]',
          '  pnpm cli review --analysis <analysis.json> [--changes <changes.json> --actor <local-user-label>] [--rebase] [--store-dir <path>] [--output <new-directory>]',
          '  pnpm cli resume --review <review.json> --claim <id>... [--kind achievement|activity] [--store-dir <path>] [--output <new-directory>]',
          '    review and resume are offline. Resume export checks the latest review version, confirmations and completion.',
          '', 'Local committed history. analyze sends selected excerpts to OpenAI (including token counting); --dry-run is offline.',
        ].join('\n'));
        return;
      case 'collect': {
        const options = parseCollectOptions(extra);
        const history = await collectLocalHistory(options);
        const files = await writeHistoryReports(history, options.outputDirectory);
        console.log(JSON.stringify({ count: history.commits.length, ...files }, null, 2));
        return;
      }
      case 'prepare':
        console.log(JSON.stringify(await executePrepare(extra), null, 2));
        return;
      case 'evidence':
        console.log(JSON.stringify(await executeEvidence(extra), null, 2));
        return;
      case 'analyze':
        console.log(JSON.stringify(await executeAnalyze(extra), null, 2));
        return;
      case 'review':
        console.log(JSON.stringify(await executeReview(extra), null, 2));
        return;
      case 'resume':
        console.log(JSON.stringify(await executeResume(extra), null, 2));
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
          collectionImplemented: true,
          remoteCollectionImplemented: false,
          llmImplemented: true,
          llmConnectionTested: false,
        }, null, 2));
        if (!git) process.exitCode = 1;
        return;
      }
      default:
        throw new Error('Unknown command. Use: pnpm cli help');
    }
  }
}
