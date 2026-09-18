import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
vi.mock('../db/queries/attachment-archive.js',()=>({recordApiUsage:vi.fn().mockResolvedValue(undefined)}));
import * as api from './api-client.js';
import {tokenManager} from './token-manager.js';
import {recordApiUsage} from '../db/queries/attachment-archive.js';

describe('historical process code lookup by schema name',()=>{
  beforeEach(()=>{vi.mocked(recordApiUsage).mockResolvedValue(undefined);vi.spyOn(tokenManager,'getToken').mockResolvedValue('synthetic-token');});
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
  it('encodes the exact historical template name and parses the flat process code response',async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({processCode:'HISTORY',gmtModified:'2026-01-01T00:00Z'})));
    vi.stubGlobal('fetch',fetch);
    expect(await api.getProcessCodeByName('Example 财务-BU')).toBe('HISTORY');
    expect(fetch.mock.calls[0][0]).toBe('https://api.dingtalk.com/v1.0/workflow/processCentres/schemaNames/processCodes?name=Example%20%E8%B4%A2%E5%8A%A1-BU');
  });
  it('does not turn an empty successful response into a resolved template',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({}))));
    await expect(api.getProcessCodeByName('Missing-BU')).rejects.toThrow('processCode');
  });
});
