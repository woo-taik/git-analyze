import type pg from 'pg';
export interface AnalysisJobScope { ownerId: string; repositoryId: string; workItemId: string }
export interface AnalysisJobRow {
  id: string; owner_id: string; repository_id: string; work_item_id: string; request_key: string;
  request: unknown; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_input';
  result: unknown; error: unknown; lease_token: string | null; created_at: Date; updated_at: Date;
}
export class AnalysisJobStore {
  constructor(private readonly pool: pg.Pool) {}
  async submit(scope: AnalysisJobScope, key: string, request: unknown) {
    const values = [scope.ownerId, scope.repositoryId, scope.workItemId, key, JSON.stringify(request)];
    const inserted = await this.pool.query<AnalysisJobRow>(`
      INSERT INTO analysis_jobs (owner_id,repository_id,work_item_id,request_key,request)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`, values);
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await this.pool.query<AnalysisJobRow>(`SELECT * FROM analysis_jobs
      WHERE owner_id=$1 AND repository_id=$2 AND work_item_id=$3 AND request_key=$4`, values.slice(0,4));
    if (!existing.rows[0]) throw new Error('Missing job after conflict');
    return existing.rows[0];
  }
  async get(scope: AnalysisJobScope, id: string) {
    return (await this.pool.query<AnalysisJobRow>(`SELECT * FROM analysis_jobs
      WHERE id=$1 AND owner_id=$2 AND repository_id=$3 AND work_item_id=$4`,
      [id,scope.ownerId,scope.repositoryId,scope.workItemId])).rows[0];
  }
  async pending() {
    await this.pool.query(`UPDATE analysis_jobs SET status='needs_input',
      error='{"code":"execution_outcome_unknown","usage":null}'::jsonb, updated_at=now()
      WHERE status='running' AND lease_until < now()`);
    return (await this.pool.query<AnalysisJobRow>(`SELECT * FROM analysis_jobs
      WHERE status='queued' ORDER BY created_at LIMIT 50`)).rows;
  }
  async queued(id: string, ownerId: string, repositoryId: string) {
    return (await this.pool.query<AnalysisJobRow>(`SELECT * FROM analysis_jobs
      WHERE id=$1 AND owner_id=$2 AND repository_id=$3 AND status='queued'`, [id,ownerId,repositoryId])).rows[0];
  }
  async retryMissingKey(scope: AnalysisJobScope, id: string, key: string) {
    return (await this.pool.query<AnalysisJobRow>(`UPDATE analysis_jobs SET status='queued', error=NULL,
      lease_token=NULL, lease_until=NULL, updated_at=now() WHERE id=$1 AND owner_id=$2
      AND repository_id=$3 AND work_item_id=$4 AND request_key=$5 AND status='needs_input'
      AND error->>'code'='provider_key_missing' RETURNING *`,
      [id,scope.ownerId,scope.repositoryId,scope.workItemId,key])).rows[0];
  }
  async claim(id: string, scope: AnalysisJobScope, key: string) {
    return (await this.pool.query<AnalysisJobRow>(`UPDATE analysis_jobs SET status='running',
      lease_token=gen_random_uuid(), lease_until=now()+interval '5 minutes', updated_at=now()
      WHERE id=$1 AND owner_id=$2 AND repository_id=$3 AND work_item_id=$4 AND request_key=$5
      AND status='queued' RETURNING *`,[id,scope.ownerId,scope.repositoryId,scope.workItemId,key])).rows[0];
  }
  async finish(id: string, token: string, status: 'succeeded' | 'failed' | 'needs_input', result: unknown, error: unknown) {
    const changed = await this.pool.query(`UPDATE analysis_jobs SET status=$3,result=$4,error=$5,
      lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='running'`,
      [id,token,status,JSON.stringify(result),JSON.stringify(error)]);
    if (changed.rowCount !== 1) throw new Error('Analysis execution lease lost');
  }
}
