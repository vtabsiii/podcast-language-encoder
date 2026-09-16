import type { FastifyPluginAsync } from 'fastify';
import { DomainError } from '@polycast/domain';
import type { LocalFsStorage } from '../storage/local-fs.js';

export interface LocalStorageRouteOptions {
  storage: LocalFsStorage;
  /** Maximum part / object size accepted over the signed PUT (bytes). */
  maxBodyBytes: number;
}

/**
 * Signed object routes for the filesystem storage driver. `PUT` accepts an upload part,
 * `GET` streams an object. Both require a valid HMAC signature minted by the driver; no
 * session is involved, exactly like a presigned S3 URL. Registered only when STORAGE_DRIVER=local.
 */
export const localStorageRoutes: FastifyPluginAsync<LocalStorageRouteOptions> = async (
  app,
  opts,
) => {
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: opts.maxBodyBytes },
    (_req, body, done) => done(null, body),
  );

  app.put<{
    Params: { bucket: string; '*': string };
    Querystring: Record<string, string | undefined>;
  }>('/local-storage/:bucket/*', async (req, reply) => {
    const { bucket } = req.params;
    const key = req.params['*'];
    const { uploadId, partNumber, expires, signature } = req.query;
    if (!uploadId || !partNumber || !expires || !signature)
      throw new DomainError('FORBIDDEN', 'Missing signature');
    const ok = opts.storage.verify(
      {
        method: 'PUT',
        bucket,
        key,
        uploadId,
        partNumber: Number(partNumber),
        expires: Number(expires),
      },
      signature,
    );
    if (!ok) throw new DomainError('FORBIDDEN', 'Invalid or expired signature');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const etag = await opts.storage.writePart(bucket, uploadId, Number(partNumber), body);
    reply.header('ETag', etag);
    reply.header('Access-Control-Expose-Headers', 'ETag');
    return reply.status(200).send();
  });

  app.get<{
    Params: { bucket: string; '*': string };
    Querystring: Record<string, string | undefined>;
  }>('/local-storage/:bucket/*', async (req, reply) => {
    const { bucket } = req.params;
    const key = req.params['*'];
    const { expires, signature, fileName } = req.query;
    if (!expires || !signature) throw new DomainError('FORBIDDEN', 'Missing signature');
    const ok = opts.storage.verify(
      { method: 'GET', bucket, key, ...(fileName ? { fileName } : {}), expires: Number(expires) },
      signature,
    );
    if (!ok) throw new DomainError('FORBIDDEN', 'Invalid or expired signature');
    const info = await opts.storage.headObject(bucket, key);
    if (!info) throw new DomainError('NOT_FOUND', 'Object not found');
    const data = await opts.storage.getObject(bucket, key);
    const name = (fileName ?? key.split('/').pop() ?? 'download').replace(/["\r\n]/g, '');
    reply.header('Content-Type', contentTypeFor(name));
    reply.header('Content-Length', String(data.length));
    reply.header(
      'Content-Disposition',
      `${name.endsWith('.json') || name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.mp4') ? 'inline' : 'attachment'}; filename="${name}"`,
    );
    reply.header('Cache-Control', 'private, max-age=0');
    return reply.send(data);
  });
};

function contentTypeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop();
  switch (ext) {
    case 'mp4':
      return 'video/mp4';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'json':
      return 'application/json';
    case 'srt':
      return 'application/x-subrip';
    case 'vtt':
      return 'text/vtt';
    case 'sha256':
    case 'txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}
