import { describe, expect, it } from 'vitest';
import { buildObjectKey, extractAttachmentCandidates } from './attachment-extractor.js';

describe('approval attachment extraction', () => {
  it('extracts form and comment files and deduplicates by fileId', () => {
    const rows = extractAttachmentCandidates({
      corpId: 'corp/unsafe',
      processInstanceId: 'PROC/001',
      processCode: 'LOGISTICS',
      rawPayload: {
        formComponentValues: [
          {
            name: '附件',
            value: JSON.stringify([
              { fileId: 'FORM/1', spaceId: 'SPACE-1', fileName: '../packing.xlsx', fileSize: 12 },
              {
                fileId: 'IMAGE-1',
                spaceId: 'SPACE-1',
                fileName: '装箱计划.png',
                thumbnail: { authMediaId: 'THUMB-1' },
              },
            ]),
          },
        ],
        operationRecords: [
          {
            userId: 'USER-1',
            userName: '张三',
            date: '2026-09-01T02:00:00Z',
            remark: '补充附件',
            attachments: [
              { fileId: 'COMMENT-1', spaceId: 'SPACE-2', fileName: '报价.pdf', fileSize: 20 },
              { fileId: 'FORM/1', spaceId: 'SPACE-1', fileName: 'duplicate.xlsx' },
            ],
          },
        ],
      },
    });

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ fileId: 'FORM/1', origin: 'form', declaredSize: 12 });
    expect(rows[1]).toMatchObject({ fileId: 'IMAGE-1', thumbnailMediaId: 'THUMB-1' });
    expect(rows[2]).toMatchObject({
      fileId: 'COMMENT-1',
      origin: 'comment',
      commentUserId: 'USER-1',
      commentUserName: '张三',
      commentRemark: '补充附件',
    });
    expect(rows[0].objectKey).toBe('corp%2Funsafe/PROC%2F001/FORM%2F1');
  });

  it('builds an immutable path without trusting the original filename', () => {
    expect(buildObjectKey('corp', 'proc', '../../evil/name.pdf')).toBe(
      'corp/proc/..%2F..%2Fevil%2Fname.pdf',
    );
  });

  it('keeps thumbnail media as parent metadata instead of creating a fake attachment', () => {
    const rows = extractAttachmentCandidates({
      corpId: 'corp', processInstanceId: 'proc', processCode: 'code',
      rawPayload: {
        formComponentValues: [{ value: JSON.stringify([{ fileId: 'FILE', fileName: 'photo.png', thumbnail: { mediaId: 'THUMB' } }]) }],
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fileId: 'FILE', thumbnailMediaId: 'THUMB' });
  });
});
