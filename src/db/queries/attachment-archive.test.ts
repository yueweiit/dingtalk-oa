import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimPendingAttachments, enqueueCorpAttachments, enqueueTemplateAttachments, retireIneligibleAttachments, synchronizeInstanceAttachments } from './attachment-archive.js';

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
      ['corp', 'still-eligible', 'OPS', false], ['corp', 'moved', 'OPS', false],
    ]);
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO costing_read.attachment_archive'))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql.includes('SET retired_at='))).toHaveLength(1);
  });

  it('does no work when the selected template has no eligible approvals', async () => {
    query.mockResolvedValueOnce({ rows: [{ last_id: '0' }] });

    expect(await enqueueTemplateAttachments('corp', 'OPS')).toEqual({ scannedCount: 0, candidateCount: 0 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('bounds corporation-wide registration and rechecks the corporation switch under each source lock', async () => {
    query.mockResolvedValueOnce({ rows: [{ last_id: '9007199254740994' }] })
      .mockResolvedValueOnce({ rows: [{ id: '9007199254740994', process_instance_id: 'disabled-during-scan' }] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await enqueueCorpAttachments('corp')).toEqual({ scannedCount: 1, candidateCount: 0 });
    expect(query.mock.calls[0]).toEqual([expect.stringContaining('costing_read.attachment_corp_scope'), ['corp', null]]);
    expect(query.mock.calls[1]).toEqual([expect.stringContaining('LIMIT 200'), ['corp', null, '0', '9007199254740994']]);
    expect(query.mock.calls[2]).toEqual([expect.stringContaining('FOR UPDATE'), ['corp', 'disabled-during-scan']]);
    expect(query.mock.calls[3]).toEqual([expect.stringContaining('costing_read.attachment_corp_scope'),
      ['corp', 'disabled-during-scan', null, true]]);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it.each([0, -1, 1.5, 1001])('rejects an invalid retirement batch limit %s', async limit => {
    await expect(retireIneligibleAttachments(limit)).rejects.toThrow('ATTACHMENT_RETIREMENT_LIMIT_INVALID');
    expect(query).not.toHaveBeenCalled();
  });

  it('bounds retirement candidates and rechecks a scope re-enabled before its source lock', async () => {
    query.mockResolvedValueOnce({ rows: [{ corp_id: 'corp', process_instance_id: 'restored' }] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{ process_code: 'OPS', raw_payload: {
        operationRecords: [{ files: [{ fileId: 'retained-file' }] }],
      } }] }).mockResolvedValue({ rows: [] });
    expect(await retireIneligibleAttachments(100)).toBe(1);
    expect(query.mock.calls[0]).toEqual([expect.stringContaining('LIMIT $1'), [100]]);
    expect(query.mock.calls[1]).toEqual([expect.stringContaining('FOR UPDATE'), ['corp', 'restored']]);
    expect(query.mock.calls.at(-1)).toEqual([expect.stringContaining('SET retired_at='),
      ['corp', 'restored', ['retained-file']]]);
  });

  it('binds the enterprise and process selectors for a scoped claim', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await claimPendingAttachments(10, false, { corpId: 'corp', processCode: 'OPS' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('costing_read.attachment_template_instances'),
      [10, false, 'corp', null, null, 'OPS', false, false]);
  });

  it('binds live priority while preserving exact scope and canary restrictions', async () => {
    query.mockResolvedValue({ rows: [] });
    await claimPendingAttachments(1, true, { corpId: 'corp', processInstanceId: 'instance', fileId: 'file' }, true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('costing_read.attachment_collection_instances'),
      [1, true, 'corp', 'instance', 'file', null, true, false]);
  });

  it('restricts an all-template claim to the explicitly enabled corporation', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await claimPendingAttachments(10, true, { corpId: 'corp', allTemplates: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('costing_read.attachment_corp_scope'),
      [10, true, 'corp', null, null, null, false, true]);
  });

  it('marks new comment references from live refreshes without resetting failures on unchanged replays', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ process_code: 'OPS', raw_payload: {
      operationRecords: [{ files: [{ fileId: 'new-comment', fileName: 'receipt.pdf' }] }],
    } }] }).mockResolvedValue({ rows: [] });
    await synchronizeInstanceAttachments('corp', 'instance', undefined, undefined, true);
    const [sql, params] = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO costing_read.attachment_archive'))!;
    expect(params[15]).toBe(1);
    expect(sql).toContain('IS DISTINCT FROM');
    expect(sql).not.toContain("archive_status = 'pending'");
  });
});
