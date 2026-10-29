import * as http from 'node:http';
import * as https from 'node:https';
import * as Minio from 'minio';
import { getConfig } from '../config/index.js';

type ClientOptions = ConstructorParameters<typeof Minio.Client>[0];
type ResponseCallback = (response: http.IncomingMessage) => void;

/** A download owns its transport so cancellation cannot abort another request's storage client. */
export function createReadObjectOpener(options: ClientOptions) {
  return async (bucket: string, objectKey: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const native = options.useSSL === false ? http : https;
    function request(input: string | URL | http.RequestOptions, callback?: ResponseCallback): http.ClientRequest;
    function request(input: string | URL, options: http.RequestOptions, callback?: ResponseCallback): http.ClientRequest;
    function request(
      input: string | URL | http.RequestOptions,
      optionsOrCallback?: http.RequestOptions | ResponseCallback,
      callback?: ResponseCallback,
    ): http.ClientRequest {
      const extraOptions = typeof optionsOrCallback === 'object' ? optionsOrCallback : {};
      const onResponse = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      if (typeof input === 'string' || input instanceof URL) {
        return native.request(input, { ...extraOptions, signal }, onResponse);
      }
      return native.request({ ...input, signal }, onResponse);
    }
    const client = new Minio.Client({
      ...options,
      transport: { request },
      // Let the caller retry safely; SDK retry warnings include unsanitized storage error text.
      retryOptions: { disableRetry: true },
    });
    return client.getObject(bucket, objectKey);
  };
}

export async function openReadApiObject(bucket: string, objectKey: string, signal: AbortSignal) {
  const config = getConfig();
  if (!config.ARCHIVE_MINIO_ACCESS_KEY || !config.ARCHIVE_MINIO_SECRET_KEY) {
    throw new Error('ATTACHMENT_UNAVAILABLE');
  }
  return createReadObjectOpener({
    endPoint: config.ARCHIVE_MINIO_ENDPOINT,
    port: config.ARCHIVE_MINIO_PORT,
    useSSL: config.ARCHIVE_MINIO_USE_SSL,
    accessKey: config.ARCHIVE_MINIO_ACCESS_KEY,
    secretKey: config.ARCHIVE_MINIO_SECRET_KEY,
  })(bucket, objectKey, signal);
}
