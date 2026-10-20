export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly databaseUrl: string | undefined;
}

function oneOf<const T extends readonly string[]>(
  value: string,
  allowed: T,
  field: string,
): T[number] {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T[number];
}

// Pure parsing; importing this package does not load files or open connections.
export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): AppConfig {
  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const host = env.HOST?.trim() ?? '127.0.0.1';
  if (!host) throw new Error('HOST must not be empty');

  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  if (databaseUrl) {
    try {
      const parsed = new URL(databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash) {
        throw new Error('invalid PostgreSQL URL');
      }
    } catch {
      // Never echo a connection string containing credentials.
      throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
    }
  }

  return {
    nodeEnv: oneOf(env.NODE_ENV ?? 'development', ['development', 'test', 'production'], 'NODE_ENV'),
    host,
    port,
    logLevel: oneOf(env.LOG_LEVEL ?? 'info', ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], 'LOG_LEVEL'),
    databaseUrl,
  };
}
