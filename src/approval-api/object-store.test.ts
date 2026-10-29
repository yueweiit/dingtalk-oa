import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createReadObjectOpener } from './object-store.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); });

async function storageServer(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const sockets = new Set<Socket>();
  const server = createServer(handle);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback port');
  return { endPoint: '127.0.0.1', port: address.port, useSSL: false,
    region: 'us-east-1', accessKey: 'synthetic-reader', secretKey: 'synthetic-test-secret' };
}

describe('cancellable MinIO read transport against a loopback fixture', () => {
  it.each([false, true])('closes an unresponsive %s region/object request on abort', async regionLookup => {
    let onRequested!: () => void;
    let onClosed!: () => void;
    let requestedPath = '';
    const requested = new Promise<void>(resolve => { onRequested = resolve; });
    const closed = new Promise<void>(resolve => { onClosed = resolve; });
    const options = await storageServer((request, response) => {
      requestedPath = request.url ?? '';
      response.once('close', onClosed);
      onRequested();
      // No response headers: cancellation must close the actual pending HTTP request.
    });
    const open = createReadObjectOpener({ ...options, region: regionLookup ? undefined : options.region });
    const controller = new AbortController();
    const pending = open('archive', 'object', controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' });
    await requested;
    expect(requestedPath.includes('location')).toBe(regionLookup);
    controller.abort();
    await rejected;
    await closed;
  });

  it('closes an already opened response stream and its socket on abort', async () => {
    let onClosed!: () => void;
    const closed = new Promise<void>(resolve => { onClosed = resolve; });
    const options = await storageServer((_request, response) => {
      response.once('close', onClosed);
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.write('first chunk');
    });
    const controller = new AbortController();
    const stream = await createReadObjectOpener(options)('archive', 'object', controller.signal);
    const streamClosed = new Promise<void>(resolve => stream.once('close', resolve));
    stream.on('error', () => undefined);
    controller.abort();
    await streamClosed;
    await closed;
    expect(stream.destroyed).toBe(true);
  });

  it('does not cancel an independent transfer using another signal', async () => {
    let onRequested!: () => void;
    const requested = new Promise<void>(resolve => { onRequested = resolve; });
    const options = await storageServer((request, response) => {
      if (request.url?.endsWith('/waiting')) onRequested();
      else response.end('complete');
    });
    const open = createReadObjectOpener(options);
    const first = new AbortController();
    const second = new AbortController();
    const pending = open('archive', 'waiting', first.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' });
    await requested;
    const stream = await open('archive', 'ready', second.signal);
    first.abort();
    await rejected;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('complete');
    expect(second.signal.aborted).toBe(false);
  });

  it('does not start a storage request for a signal that is already aborted', async () => {
    let calls = 0;
    const options = await storageServer((_request, response) => { calls++; response.end(); });
    const controller = new AbortController();
    controller.abort();
    await expect(createReadObjectOpener(options)('archive', 'object', controller.signal)).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
