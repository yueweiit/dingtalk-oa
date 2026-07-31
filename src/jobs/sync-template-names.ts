import { listProcessTemplates } from '../dingtalk/api-client.js';
import { findAllTemplates, updateTemplateName } from '../db/queries/process-template.js';
import { getConfig } from '../config/index.js';
import { getTemplateAdminUserId } from '../dingtalk/template-admin-user.js';

/**
 * 同步钉钉模板名称到本地数据库
 * 补填 ding_process_template 表中 name 为空的记录
 */
export async function syncTemplateNames(): Promise<void> {
  try {
    const config = getConfig();
    const corpId = config.DINGTALK_CORP_ID;
    if (!corpId) {
      console.warn('[SyncTemplateNames] DINGTALK_CORP_ID 未配置，跳过同步');
      return;
    }

    // 从钉钉 API 获取所有模板
    const userId = getTemplateAdminUserId(config);
    if (!userId) {
      console.warn('[SyncTemplateNames] 未配置 DINGTALK_TEMPLATE_ADMIN_USER_ID，跳过同步');
      return;
    }
    const remoteTemplates = await listProcessTemplates(userId);
    const nameMap = new Map<string, string>();
    for (const t of remoteTemplates) {
      if (t.processCode && t.name) {
        nameMap.set(t.processCode, t.name);
      }
    }

    // 查找本地 name 为空的模板
    const localTemplates = await findAllTemplates(corpId);
    let updated = 0;
    for (const local of localTemplates) {
      if (!local.name) {
        const remoteName = nameMap.get(local.process_code);
        if (remoteName) {
          await updateTemplateName(corpId, local.process_code, remoteName);
          updated++;
          console.log(`[SyncTemplateNames] 更新模板名称: ${local.process_code} -> ${remoteName}`);
        }
      }
    }

    if (updated > 0) {
      console.log(`[SyncTemplateNames] 共更新 ${updated} 个模板名称`);
    }
  } catch (error) {
    console.error('[SyncTemplateNames] 同步模板名称失败:', error);
  }
}
