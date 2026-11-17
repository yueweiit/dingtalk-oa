import { describe, expect, it } from 'vitest';
import { parseArchiveTarget } from './archive-target.js';

describe('attachment archive targets', () => {
  it('preserves the normal collector when no target is requested', () => expect(parseArchiveTarget([])).toBeUndefined());

  it('requires exact corporation, instance and file together', () => {
    expect(parseArchiveTarget(['--corp-id=example','--instance-id=approval','--file-id=file']))
      .toEqual({corpId:'example',processInstanceId:'approval',fileId:'file'});
  });

  it('supports enqueue-only and queue download for one corporation and process code', () => {
    const scope = ['--corp-id=example', '--process-code=OPS'];
    expect(parseArchiveTarget(scope)).toEqual({ corpId: 'example', processCode: 'OPS', enqueueOnly: false });
    expect(parseArchiveTarget([...scope, '--enqueue-only']))
      .toEqual({ corpId: 'example', processCode: 'OPS', enqueueOnly: true });
  });

  it.each([
    { args: ['--file-id=file'] },
    { args: ['--corp-id=example', '--instance-id=approval', '--file-id='] },
    { args: ['--corp-id=example', '--instance-id=approval', '--file-id=file', '--file-id=second'] },
    { args: ['--flie-id=typo'] },
    { args: ['--process-code=OPS'] },
    { args: ['--enqueue-only'] },
    { args: ['--corp-id=example', '--process-code=OPS', '--file-id=file'] },
    { args: ['--corp-id=example', '--process-code=OPS', '--enqueue-only', '--enqueue-only'] },
  ])('rejects invalid arguments $args', ({ args }) => expect(() => parseArchiveTarget(args)).toThrow());
});
