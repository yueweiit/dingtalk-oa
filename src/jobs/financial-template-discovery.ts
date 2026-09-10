import {listProcessTemplates,getProcessCodeByName,delay} from '../dingtalk/api-client.js';
import {localFinancialTemplateNames,seedFinancialTemplateNames,pendingFinancialTemplateNames,
  registerDiscoveredFinancialTemplate,recordFinancialDiscoveryFailure} from '../db/queries/financial-template-discovery.js';

export function isFinancialTemplateName(name:string):boolean {
  return /(采购|支出|费用|报销|付款|支付|请款|结算|月结|gastos|compra|pago|reembolso|expense|payment|purchase|[- _]bu$)/i.test(name);
}
export interface FinancialDiscoveryDependencies {
  current:typeof listProcessTemplates;
  localNames:typeof localFinancialTemplateNames;
  seedNames:typeof seedFinancialTemplateNames;
  pendingNames:typeof pendingFinancialTemplateNames;
  lookup:typeof getProcessCodeByName;
  register:typeof registerDiscoveredFinancialTemplate;
  recordFailure:typeof recordFinancialDiscoveryFailure;
  wait:typeof delay;
}
const defaults:FinancialDiscoveryDependencies={current:listProcessTemplates,localNames:localFinancialTemplateNames,
  seedNames:seedFinancialTemplateNames,pendingNames:pendingFinancialTemplateNames,lookup:getProcessCodeByName,
  register:registerDiscoveredFinancialTemplate,recordFailure:recordFinancialDiscoveryFailure,wait:delay};

export async function discoverFinancialTemplates(options:{corpId:string;userId?:string;names?:string[]},deps:FinancialDiscoveryDependencies=defaults) {
  const result={registered:0,failed:0};
  if(options.userId){
    for(const template of await deps.current(options.userId)){
      if(isFinancialTemplateName(template.name ?? '')){
        await deps.register(options.corpId,template.processCode,template.name ?? '',true); result.registered++;
      }
    }
  }
  const names=[...new Set([...(await deps.localNames(options.corpId)),...(options.names??[])].map(n=>n.trim()).filter(Boolean))];
  await deps.seedNames(options.corpId,names);
  for(const name of await deps.pendingNames(options.corpId)){
    try{
      const code=await deps.lookup(name);
      await deps.register(options.corpId,code,name); result.registered++;
    }catch(error){await deps.recordFailure(options.corpId,name,error); result.failed++;}
    await deps.wait(500);
  }
  return result;
}
