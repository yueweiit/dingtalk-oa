import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  findTemplate: vi.fn(), saveTemplate: vi.fn(), corpEnabled: vi.fn(), fetch: vi.fn(), saveInstance: vi.fn(),
  insertEvent: vi.fn(), status: vi.fn(), emptyNodes: vi.fn(), budget: vi.fn(),
}));
vi.mock('../dingtalk/api-client.js', () => ({ getInstance: state.fetch, listProcessTemplates: vi.fn() }));
vi.mock('../config/index.js', () => ({ getConfig: () => ({}) }));
vi.mock('../dingtalk/template-admin-user.js', () => ({ getTemplateAdminUserId: () => undefined }));
vi.mock('../db/pool.js', () => ({ withTransaction: (run: (client: object) => Promise<void>) => run({}) }));
vi.mock('../db/queries/process-template.js', () => ({
  findByCorpAndProcessCode: state.findTemplate, upsertProcessTemplate: state.saveTemplate, updateTemplateName: vi.fn(),
}));
vi.mock('../db/queries/attachment-archive.js', () => ({ isAttachmentCorpEnabled: state.corpEnabled }));
vi.mock('../db/queries/approval-instance.js', () => ({ upsertInstance: state.saveInstance }));
vi.mock('../db/queries/approval-task.js', () => ({ upsertTask: vi.fn() }));
vi.mock('../db/queries/event-log.js', () => ({ insertEvent: state.insertEvent, updateEventStatus: state.status }));
vi.mock('../db/queries/corp-config.js', () => ({ saveCorpId: vi.fn() }));
vi.mock('../db/queries/approval-enrichment.js', () => ({ tryRepairApprovalMetadata: vi.fn() }));
vi.mock('../db/queries/user-departure.js', () => ({ syncApprovalDeparture: vi.fn() }));
vi.mock('./approval-user-sync.js', () => ({ syncApprovalUsers: vi.fn() }));
vi.mock('./form-field-extractor.js', () => ({ saveFormFields: vi.fn() }));
vi.mock('../jobs/approval-empty-node-monitor.js', () => ({ monitorEmptyApprovalNodesForInstance: state.emptyNodes }));
vi.mock('../jobs/budget-alert-monitor.js', () => ({ monitorBudgetAlertForInstance: state.budget }));

import { processApprovalMessage } from './orchestrator.js';

describe('corporation-wide attachment event ingestion', () => {
  const event = { eventType: 'bpms_instance_change', corpId: 'corp', processInstanceId: 'instance',
    processCode: 'NEW', payload: {}, source: 'test', receivedAt: '2026-11-18T00:00:00Z' };
  beforeEach(() => {
    vi.resetAllMocks();
    state.insertEvent.mockResolvedValue({ event: { id: 1n, status: 'pending' }, isDuplicate: false });
    state.fetch.mockResolvedValue({ status: 'RUNNING', processCode: 'NEW', operationRecords: [{ files: [{ fileId: 'new-file' }] }] });
    state.saveInstance.mockResolvedValue({});
    state.emptyNodes.mockResolvedValue({ status: 'skipped', emptyNodes: [], sent: false });
    state.budget.mockResolvedValue({ status: 'skipped', sent: false });
  });

  it('discovers a future template from its first event and persists its attachment references', async () => {
    state.findTemplate.mockResolvedValue(null);
    await processApprovalMessage(event);
    expect(state.saveTemplate).toHaveBeenCalledWith({ corp_id: 'corp', process_code: 'NEW', name: null, enabled: true });
    expect(state.saveInstance).toHaveBeenCalledWith(expect.objectContaining({
      corp_id: 'corp', process_code: 'NEW', raw_payload: expect.objectContaining({ operationRecords: [{ files: [{ fileId: 'new-file' }] }] }),
    }), expect.anything(), true);
    expect(state.status).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('archives disabled templates for an opted-in corporation without enabling their notifications', async () => {
    state.findTemplate.mockResolvedValue({ enabled: false });
    state.corpEnabled.mockResolvedValue(true);
    await processApprovalMessage(event);
    expect(state.corpEnabled).toHaveBeenCalledWith('corp');
    expect(state.fetch).toHaveBeenCalledWith('instance');
    expect(state.saveInstance).toHaveBeenCalledTimes(1);
    expect(state.saveTemplate).not.toHaveBeenCalled();
    expect(state.emptyNodes).not.toHaveBeenCalled();
    expect(state.budget).not.toHaveBeenCalled();
    expect(state.status).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('preserves disabled-template handling for corporations that have not opted in', async () => {
    state.findTemplate.mockResolvedValue({ enabled: false });
    state.corpEnabled.mockResolvedValue(false);
    await processApprovalMessage(event);
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.saveInstance).not.toHaveBeenCalled();
    expect(state.status).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'skipped' }));
  });

  it('preserves notifications for enabled templates', async () => {
    state.findTemplate.mockResolvedValue({ enabled: true });
    await processApprovalMessage(event);
    expect(state.emptyNodes).toHaveBeenCalledTimes(1);
    expect(state.budget).toHaveBeenCalledTimes(1);
    expect(state.corpEnabled).not.toHaveBeenCalled();
  });
});
