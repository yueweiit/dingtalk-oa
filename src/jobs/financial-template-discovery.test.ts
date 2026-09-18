import { describe, expect, it, vi } from 'vitest';
import * as discovery from './financial-template-discovery.js';

describe('financial historical template discovery', () => {
  it('uses current list plus retained local names and explicit historical names; records lookup failures durably', async () => {
    const resolved:string[]=[]; const failed:string[]=[];
    const deps = {
      current: async () => [{name:'月度付款',processCode:'CURRENT'},{name:'请假',processCode:'IRRELEVANT'}],
      localNames: async () => ['Example-BU','历史费用报销'],
      seedNames: vi.fn(async () => undefined),
      pendingNames: async () => ['Example-BU','Missing-BU'],
      lookup: async (name:string) => {if(name==='Missing-BU') throw new Error('not found'); return 'HISTORICAL';},
      register: vi.fn(async (_corp:string,code:string) => {resolved.push(code);}),
      recordFailure: async (_corp:string,name:string) => {failed.push(name);},
      wait: async () => undefined,
    };
    const result=await discovery.discoverFinancialTemplates({corpId:'corp',userId:'user',names:['Missing-BU']},deps);
    expect(resolved).toEqual(['CURRENT','HISTORICAL']); expect(failed).toEqual(['Missing-BU']);
    expect(deps.seedNames).toHaveBeenCalledWith('corp',['Example-BU','历史费用报销','Missing-BU']);
    expect(result).toEqual({registered:2,failed:1});
  });

  it.each(['采购申请','运营支出','报销','月度付款','Example-BU','Gastos operativos','Payment request'])('recognizes financial family %s', name => {
    expect(discovery.isFinancialTemplateName(name)).toBe(true);
  });
  it.each(['请假','国际物流申请','培训申请'])('does not classify %s as finance by name alone', name => {
    expect(discovery.isFinancialTemplateName(name)).toBe(false);
  });
});
