import { parseArgs } from 'node:util';

const PERIODS = ['1w', '1m', '3m', '6m'] as const;
const KST_OFFSET = 9 * 60 * 60 * 1_000;

export function parseCollectOptions(args: readonly string[], now = new Date()) {
  const { values } = parseArgs({
    args: [...args], strict: true, allowPositionals: false,
    options: {
      repo: { type: 'string' }, period: { type: 'string', default: '1w' },
      ref: { type: 'string', default: 'HEAD' }, output: { type: 'string' },
      path: { type: 'string' },
    },
  });
  if (!values.repo?.trim()) throw new Error('collect requires --repo <local-path>');
  const period = values.period as (typeof PERIODS)[number];
  if (!PERIODS.includes(period)) throw new Error('--period must be 1w, 1m, 3m, or 6m');
  if (!values.ref?.trim() || values.ref.startsWith('-')) throw new Error('Invalid --ref');
  if (values.output !== undefined && !values.output.trim()) throw new Error('Invalid --output');
  if (values.path !== undefined && !values.path.trim()) throw new Error('Invalid --path');
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid collection time');

  let start: Date;
  if (period === '1w') {
    start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000);
  } else {
    const local = new Date(now.getTime() + KST_OFFSET);
    const day = local.getUTCDate();
    local.setUTCDate(1);
    local.setUTCMonth(local.getUTCMonth() - Number.parseInt(period, 10));
    const lastDay = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
    local.setUTCDate(Math.min(day, lastDay));
    start = new Date(local.getTime() - KST_OFFSET);
  }
  return {
    repositoryPath: values.repo, ref: values.ref,
    period, startAt: start.toISOString(), endAt: now.toISOString(), outputDirectory: values.output,
    ...(values.path === undefined ? {} : { pathFilter: values.path }),
  };
}
