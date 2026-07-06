/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // ========== ding_process_template 审批流程模板 ==========
  pgm.sql(`COMMENT ON TABLE ding_process_template IS '审批流程模板 - 钉钉审批流程定义的注册表'`);
  pgm.sql(`COMMENT ON COLUMN ding_process_template.id IS '主键ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_process_template.corp_id IS '企业ID（租户标识）'`);
  pgm.sql(`COMMENT ON COLUMN ding_process_template.process_code IS '钉钉流程编码（流程唯一标识）'`);
  pgm.sql(`COMMENT ON COLUMN ding_process_template.name IS '流程模板名称'`);
  pgm.sql(`COMMENT ON COLUMN ding_process_template.enabled IS '是否启用同步（true=同步该流程）'`);
  pgm.sql(`COMMENT ON COLUMN ding_process_template.is_deleted IS '是否已删除（软删除标记）'`);
  pgm.sql(`COMMENT ON COLUMN ding_process_template.remark IS '备注说明'`);
  pgm.sql(`COMMENT ON COLUMN ding_process_template.last_sync_at IS '最近一次同步时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_process_template.updated_at IS '记录最后更新时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_process_template.created_at IS '记录创建时间'`);

  // ========== ding_approval_instance 审批实例 ==========
  pgm.sql(`COMMENT ON TABLE ding_approval_instance IS '审批实例 - 每次审批提交对应一条记录，是核心业务表'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.id IS '主键ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.corp_id IS '企业ID（租户标识）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.process_instance_id IS '钉钉审批实例ID（实例唯一标识）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.process_code IS '关联的流程编码'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.title IS '审批标题（如：张三的请假申请）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.status IS '实例状态（NEW/COMPLETED/TERMINATED等）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.result IS '审批结果（agree=同意/refuse=拒绝等）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.originator_user_id IS '发起人用户ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.originator_user_name IS '发起人姓名'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.originator_dept_id IS '发起人所在部门ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.originator_dept_name IS '发起人所在部门名称'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.create_time IS '审批发起时间（钉钉侧）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.finish_time IS '审批完成时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.form_component_values IS '表单组件数据（JSONB，存储所有表单字段的值）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.raw_payload IS '钉钉API原始返回数据（JSONB，用于后续重处理）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.last_event_time IS '最后一次收到事件推送的时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.deleted_at IS '软删除时间（非空表示已删除）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.updated_at IS '记录最后更新时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_instance.created_at IS '记录创建时间'`);

  // ========== ding_approval_task 审批任务节点 ==========
  pgm.sql(`COMMENT ON TABLE ding_approval_task IS '审批任务节点 - 审批流程中每个审批人/节点的处理记录'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.id IS '主键ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.corp_id IS '企业ID（租户标识）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.process_instance_id IS '所属审批实例ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.task_id IS '钉钉任务ID（任务节点唯一标识）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.task_order IS '任务节点顺序号'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.activity_id IS '活动节点ID（流程定义中的节点标识）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.node_name IS '节点名称（如：部门主管审批、财务审核）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.status IS '任务状态（RUNNING/COMPLETED/TERMINATED等）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.result IS '任务处理结果（agree=同意/refuse=拒绝等）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.approver_user_id IS '审批人用户ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.approver_user_name IS '审批人姓名'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.approver_dept_id IS '审批人所在部门ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.approver_dept_name IS '审批人所在部门名称'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.start_time IS '任务开始时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.end_time IS '任务完成时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.remark IS '审批意见/备注'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.raw_payload IS '钉钉API原始返回数据（JSONB）'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.updated_at IS '记录最后更新时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_approval_task.created_at IS '记录创建时间'`);

  // ========== ding_user_snapshot 用户快照 ==========
  pgm.sql(`COMMENT ON TABLE ding_user_snapshot IS '用户信息快照 - 用户数据变更时生成新快照（基于hash去重）'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.id IS '主键ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.corp_id IS '企业ID（租户标识）'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.user_id IS '钉钉用户ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.name IS '用户姓名'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.dept_id_list IS '所属部门ID列表（JSONB数组）'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.title IS '职位/头衔'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.avatar IS '头像URL'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.snapshot_hash IS '快照数据哈希值（用于判断数据是否变化）'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.valid_from IS '快照生效时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.valid_to IS '快照失效时间（当前快照为NULL）'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.is_current IS '是否为当前有效快照'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.fetch_status IS '数据获取状态（success/failed）'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.fetch_error IS '数据获取失败时的错误信息'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.raw_payload IS '钉钉API原始返回数据（JSONB）'`);
  pgm.sql(`COMMENT ON COLUMN ding_user_snapshot.updated_at IS '记录最后更新时间'`);

  // ========== ding_form_field 表单字段 ==========
  pgm.sql(`COMMENT ON TABLE ding_form_field IS '审批表单字段 - 每个审批流程模板的表单字段元数据'`);
  pgm.sql(`COMMENT ON COLUMN ding_form_field.id IS '主键ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_form_field.corp_id IS '企业ID（租户标识）'`);
  pgm.sql(`COMMENT ON COLUMN ding_form_field.process_code IS '关联的流程编码'`);
  pgm.sql(`COMMENT ON COLUMN ding_form_field.field_id IS '字段ID（流程模板内的字段唯一标识）'`);
  pgm.sql(`COMMENT ON COLUMN ding_form_field.field_name IS '字段显示名称'`);
  pgm.sql(`COMMENT ON COLUMN ding_form_field.field_type IS '字段类型（如：textarea/number/date等）'`);
  pgm.sql(`COMMENT ON COLUMN ding_form_field.is_deleted IS '是否已删除（软删除标记）'`);
  pgm.sql(`COMMENT ON COLUMN ding_form_field.raw_payload IS '钉钉API原始返回数据（JSONB）'`);
  pgm.sql(`COMMENT ON COLUMN ding_form_field.updated_at IS '记录最后更新时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_form_field.created_at IS '记录创建时间'`);

  // ========== backfill_cursor 回填进度 ==========
  pgm.sql(`COMMENT ON TABLE backfill_cursor IS '历史数据回填进度 - 跟踪批量回填任务的执行状态和进度'`);
  pgm.sql(`COMMENT ON COLUMN backfill_cursor.id IS '主键ID'`);
  pgm.sql(`COMMENT ON COLUMN backfill_cursor.corp_id IS '企业ID（租户标识）'`);
  pgm.sql(`COMMENT ON COLUMN backfill_cursor.process_code IS '流程编码'`);
  pgm.sql(`COMMENT ON COLUMN backfill_cursor.window_start IS '回填时间窗口起始时间'`);
  pgm.sql(`COMMENT ON COLUMN backfill_cursor.window_end IS '回填时间窗口结束时间'`);
  pgm.sql(`COMMENT ON COLUMN backfill_cursor.status IS '任务状态（running/completed/failed）'`);
  pgm.sql(`COMMENT ON COLUMN backfill_cursor.cursor_offset IS '当前游标偏移量（分页用）'`);
  pgm.sql(`COMMENT ON COLUMN backfill_cursor.processed_count IS '已处理记录数'`);
  pgm.sql(`COMMENT ON COLUMN backfill_cursor.started_at IS '任务开始时间'`);
  pgm.sql(`COMMENT ON COLUMN backfill_cursor.finished_at IS '任务完成时间'`);
  pgm.sql(`COMMENT ON COLUMN backfill_cursor.error_message IS '失败时的错误信息'`);
  pgm.sql(`COMMENT ON COLUMN backfill_cursor.created_at IS '记录创建时间'`);

  // ========== ding_event_log 事件日志 ==========
  pgm.sql(`COMMENT ON TABLE ding_event_log IS '事件日志 - 记录所有钉钉推送事件，用于去重、重试和审计'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.id IS '主键ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.corp_id IS '企业ID（租户标识）'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.event_id IS '钉钉事件ID（用于去重，部分事件可能为空）'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.event_type IS '事件类型（如：bpms_instance_change等）'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.source IS '事件来源（callback=回调推送/backfill=主动回填等）'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.process_instance_id IS '关联的审批实例ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.process_code IS '关联的流程编码'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.received_at IS '事件接收时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.processed_at IS '事件处理完成时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.duration_ms IS '处理耗时（毫秒）'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.status IS '处理状态（pending/processing/success/failed/skipped）'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.retry_count IS '重试次数'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.error_message IS '处理失败时的错误信息'`);
  pgm.sql(`COMMENT ON COLUMN ding_event_log.raw_event IS '原始事件数据（JSONB）'`);

  // ========== ding_corp_config 企业配置 ==========
  pgm.sql(`COMMENT ON TABLE ding_corp_config IS '企业配置 - 存储钉钉企业/租户的基本信息和启用状态'`);
  pgm.sql(`COMMENT ON COLUMN ding_corp_config.id IS '主键ID'`);
  pgm.sql(`COMMENT ON COLUMN ding_corp_config.corp_id IS '钉钉企业ID（唯一标识）'`);
  pgm.sql(`COMMENT ON COLUMN ding_corp_config.corp_name IS '企业名称'`);
  pgm.sql(`COMMENT ON COLUMN ding_corp_config.is_active IS '是否启用（false=暂停该企业的数据同步）'`);
  pgm.sql(`COMMENT ON COLUMN ding_corp_config.created_at IS '记录创建时间'`);
  pgm.sql(`COMMENT ON COLUMN ding_corp_config.updated_at IS '记录最后更新时间'`);
};

exports.down = (pgm) => {
  // 清除所有表和字段的注释（设为NULL即删除注释）
  const tables = [
    'ding_process_template',
    'ding_approval_instance',
    'ding_approval_task',
    'ding_user_snapshot',
    'ding_form_field',
    'backfill_cursor',
    'ding_event_log',
    'ding_corp_config',
  ];
  for (const table of tables) {
    pgm.sql(`COMMENT ON TABLE ${table} IS NULL`);
  }
};
