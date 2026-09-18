import { describe,expect,it } from 'vitest';
import {parseArchiveTarget} from './archive-target.js';
describe('exact attachment target',()=>{
  it('preserves the normal collector when no target is requested',()=>expect(parseArchiveTarget([])).toBeUndefined());
  it('requires exact corporation, instance and file together',()=>{
    expect(parseArchiveTarget(['--corp-id=example','--instance-id=approval','--file-id=file']))
      .toEqual({corpId:'example',processInstanceId:'approval',fileId:'file'});
  });
  it.each([['--file-id=file'],['--corp-id=example','--instance-id=approval','--file-id='],
    ['--corp-id=example','--instance-id=approval','--file-id=file','--file-id=second'],['--flie-id=typo']])
    ('rejects incomplete or misspelled input instead of scanning all files: %j',(...args)=>expect(()=>parseArchiveTarget(args)).toThrow());
});
