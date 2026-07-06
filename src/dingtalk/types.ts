import { z } from 'zod';

// Token 响应（oapi 格式）
export const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  errcode: z.number().optional(),
  errmsg: z.string().optional(),
});

// 审批模板
export const processTemplateSchema = z.object({
  name: z.string().optional(),
  processCode: z.string(),
  flowTitle: z.string().optional(),
  description: z.string().optional(),
}).passthrough();

export const listProcessTemplatesResponseSchema = z.object({
  result: z.array(processTemplateSchema),
});

// 审批实例搜索
export const approvalInstanceSchema = z.object({
  title: z.string().optional(),
  processInstanceId: z.string(),
  processCode: z.string(),
  originatorId: z.string().optional(),
  originatorDeptId: z.string().optional(),
  status: z.string(),
  result: z.string().optional(),
  createTime: z.string().optional(),
  finishTime: z.string().optional(),
  businessId: z.string().optional(),
});

export const searchInstancesResponseSchema = z.object({
  result: z.object({
    list: z.array(approvalInstanceSchema),
    totalCount: z.number().optional(),
    nextToken: z.union([z.string(), z.number()]).optional(),
  }),
});

// 审批实例详情
export const formComponentValueSchema = z.object({
  name: z.string().nullish(),
  value: z.string().nullish(),
  componentType: z.string().nullish(),
  id: z.string().nullish(),
  extValue: z.string().nullish(),
}).passthrough();

export const approvalTaskSchema = z.object({
  activityId: z.string().nullish(),
  taskId: z.preprocess((val) => (val != null ? String(val) : undefined), z.string().optional()),
  nodeName: z.string().nullish(),
  status: z.string(),
  result: z.string().nullish(),
  userId: z.string().nullish(),
  userName: z.string().nullish(),
  deptId: z.string().nullish(),
  deptName: z.string().nullish(),
  startTime: z.string().nullish(),
  endTime: z.string().nullish(),
  remark: z.string().nullish(),
}).passthrough();

export const approvalInstanceDetailSchema = z.object({
  title: z.string().nullish(),
  processInstanceId: z.string().nullish(),
  processCode: z.string().nullish(),
  originatorId: z.string().nullish(),
  originatorDeptId: z.string().nullish(),
  status: z.string(),
  result: z.string().nullish(),
  createTime: z.string().nullish(),
  finishTime: z.string().nullish(),
  businessId: z.string().nullish(),
  formComponentValues: z.array(formComponentValueSchema).optional(),
  tasks: z.array(approvalTaskSchema).optional(),
  operationRecords: z.array(z.any()).optional(),
  originator: z.object({
    userId: z.string().nullish(),
    name: z.string().nullish(),
    deptId: z.string().nullish(),
    deptName: z.string().nullish(),
  }).optional(),
}).passthrough();

export const getInstanceResponseSchema = z.object({
  result: approvalInstanceDetailSchema,
});

// 用户信息
export const userInfoSchema = z.object({
  userid: z.string(),
  name: z.string().optional(),
  title: z.string().optional(),
  avatar: z.string().optional(),
  dept_id_list: z.array(z.preprocess((v) => String(v), z.string())).optional(),
  unionid: z.string().optional(),
});

export const getUserResponseSchema = z.object({
  result: userInfoSchema,
});

// Stream 事件
export const streamEventSchema = z.object({
  CorpId: z.string(),
  EventType: z.string(),
  ProcessInstanceId: z.string().optional(),
  ProcessCode: z.string().optional(),
  Type: z.string().optional(),
  Result: z.string().optional(),
  TimeStamp: z.string().optional(),
  EventId: z.string().optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export type ProcessTemplate = z.infer<typeof processTemplateSchema>;
export type ApprovalInstance = z.infer<typeof approvalInstanceSchema>;
export type ApprovalInstanceDetail = z.infer<typeof approvalInstanceDetailSchema>;
export type ApprovalTask = z.infer<typeof approvalTaskSchema>;
export type FormComponentValue = z.infer<typeof formComponentValueSchema>;
export type UserInfo = z.infer<typeof userInfoSchema>;
export type StreamEvent = z.infer<typeof streamEventSchema>;
