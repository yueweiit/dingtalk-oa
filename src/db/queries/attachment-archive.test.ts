import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimPendingAttachments, enqueueTemplateAttachments } from './attachment-archive.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../pool.js', () => ({
  withClient: (run: (client: { query: typeof query }) => unknown) => run({ query }),
  withTransaction: (run: (client: { query: typeof query }) => unknown) => run({ query }),
}));

describe('template attachment archive', () => {
  beforeEach(() => query.mockReset());

  it('queues exact scoped approvals in pages and skips a source that left the scope', async () => {
    const firstId = '9007199254740993';
    const lastId = '9007199254740994';
    query
      .mockResolvedValueOnce({ rows: [{ last_id: lastId }] })
      .mockResolvedValueOnce({ rows: [{ id: firstId, process_instance_id: 'still-eligible' }] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{
        process_code: 'OPS',
        raw_payload: { operationRecords: [{ files: [{ fileId: 'receipt', fileName: 'receipt.pdf' }] }] },
      }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: lastId, process_instance_id: 'moved' }] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [] });

    expect(await enqueueTemplateAttachments('corp', 'OPS')).toEqual({ scannedCount: 2, candidateCount: 1 });
    const pages = query.mock.calls.filter(([sql]) => sql.includes('LIMIT 200'));
    expect(pages.map(([, params]) => params)).toEqual([
      ['corp', 'OPS', '0', lastId],
      ['corp', 'OPS', firstId, lastId],
    ]);
    const scopedLookups = query.mock.calls.filter(([sql]) => sql.includes('SELECT process_code, raw_payload'));
    expect(scopedLookups.map(([, params]) => params)).toEqual([
      ['corp', 'still-eligible', 'OPS'], ['corp', 'moved', 'OPS'],
    ]);
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO costing_read.attachment_archive'))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql.includes('SET retired_at='))).toHaveLength(1);
  });

  it('does no work when the selected template has no eligible approvals', async () => {
    query.mockResolvedValueOnce({ rows: [{ last_id: '0' }] });

    expect(await enqueueTemplateAttachments('corp', 'OPS')).toEqual({ scannedCount: 0, candidateCount: 0 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('binds the enterprise and process selectors for a scoped claim', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await claimPendingAttachments(10, false, { corpId: 'corp', processCode: 'OPS' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('costing_read.attachment_template_instances'),
      [10, false, 'corp', null, null, 'OPS']);
  });
});
