import type { AppConfig } from '../config.js';
import type { StorageDriver } from './driver.js';
import { LocalFsStorage } from './local-fs.js';
import { S3Storage } from './s3.js';

export * from './driver.js';
export { LocalFsStorage } from './local-fs.js';
export { S3Storage } from './s3.js';

export interface Buckets {
  readonly quarantine: string;
  readonly source: string;
  readonly derived: string;
  readonly deliverables: string;
}

export function bucketsFromConfig(config: AppConfig): Buckets {
  return {
    quarantine: config.MEDIA_BUCKET_QUARANTINE,
    source: config.MEDIA_BUCKET_SOURCE,
    derived: config.MEDIA_BUCKET_DERIVED,
    deliverables: config.MEDIA_BUCKET_DELIVERABLES,
  };
}

export function createStorage(config: AppConfig): StorageDriver {
  if (config.STORAGE_DRIVER === 's3') {
    return new S3Storage({
      region: config.AWS_REGION,
      endpoint: config.S3_ENDPOINT,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      ttlSeconds: config.SIGNED_URL_TTL_SECONDS,
    });
  }
  return new LocalFsStorage({
    rootDir: config.LOCAL_STORAGE_DIR,
    publicBaseUrl: config.PUBLIC_API_URL ?? `http://${config.HOST}:${config.PORT}`,
    secret: config.LOCAL_JWT_SECRET,
    ttlSeconds: config.SIGNED_URL_TTL_SECONDS,
  });
}
