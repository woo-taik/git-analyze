import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export const isLoopbackHost = (host: string) => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host);

/** These endpoints expose a local archive; owner IDs are selectors, not authentication. */
@Injectable()
export class LocalArchiveGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    try {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) throw new Error();
      const host = new URL(`http://${request.headers.host ?? ''}`);
      if (!isLoopbackHost(host.hostname) || host.username || host.password || host.pathname !== '/' || host.search || host.hash) throw new Error();
      if (request.headers.origin !== undefined) {
        const origin = new URL(request.headers.origin);
        if (origin.origin !== host.origin) throw new Error();
      }
      return true;
    } catch { throw new ForbiddenException('local_archive_access_required'); }
  }
}
