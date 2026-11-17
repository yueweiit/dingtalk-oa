import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fetchArchiveContent } from './archive-runtime.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('archive content transfer', () => {
  it('preserves bytes and required download headers', async () => {
    const bytes = Buffer.from('%PDF-test');
    const fetch = vi.fn().mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchArchiveContent('https://example.invalid/file', { Authorization: 'synthetic' }, 1000))
      .toEqual({ body: bytes, contentType: 'application/pdf' });
    expect(fetch).toHaveBeenCalledWith('https://example.invalid/file', expect.objectContaining({
      headers: { Authorization: 'synthetic' }, signal: expect.any(AbortSignal),
    }));
  });

  it('cancels a stalled response body within the timeout', async () => {
    const server = createServer((_req, response) => {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.write('%PDF-');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    try {
      await expect(fetchArchiveContent(`http://127.0.0.1:${address.port}/file`, {}, 100)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('rejects an HTTP failure without including the signed URI', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })));
    await expect(fetchArchiveContent('https://example.invalid/file?signature=private', {}, 1000))
      .rejects.toMatchObject({ message: 'ATTACHMENT_DOWNLOAD_HTTP_403', code: 'attachment_content_http_error' });
  });
});
