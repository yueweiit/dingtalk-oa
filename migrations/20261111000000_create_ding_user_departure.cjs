exports.up = (pgm) => {
  pgm.sql(`
    SET LOCAL lock_timeout = '5s';
    CREATE TABLE public.ding_user_departure (
      corp_id varchar(64) NOT NULL,
      source_process_instance_id varchar(128) NOT NULL,
      source_process_code varchar(128) NOT NULL,
      region varchar(2) NOT NULL CHECK (region IN ('CN', 'MX')),
      employee_name text,
      dingtalk_name text,
      departed_on date,
      user_id varchar(128),
      identity_method text,
      candidate_user_id varchar(128),
      identity_review_required boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (corp_id, source_process_instance_id),
      FOREIGN KEY (corp_id, source_process_instance_id)
        REFERENCES public.ding_approval_instance (corp_id, process_instance_id) ON DELETE RESTRICT,
      CHECK (
        (user_id IS NULL AND identity_method IS NULL) OR
        (user_id IS NOT NULL AND btrim(user_id) <> '' AND identity_method IS NOT NULL AND (
          (region = 'CN' AND identity_method = 'originator') OR
          (region = 'MX' AND identity_method = 'manual')
        ))
      ),
      CHECK (candidate_user_id IS NULL OR (region = 'MX' AND user_id IS NULL AND btrim(candidate_user_id) <> '')),
      CHECK (NOT identity_review_required OR identity_method IS NOT DISTINCT FROM 'manual')
    );
    CREATE INDEX ding_user_departure_effective_lookup
      ON public.ding_user_departure (corp_id, user_id, departed_on)
      WHERE user_id IS NOT NULL AND departed_on IS NOT NULL AND NOT identity_review_required;
    COMMENT ON TABLE public.ding_user_departure IS
      '已通过的离职审批及员工身份核对结果，按来源实例追溯';
  `);
};

exports.down = () => {
  throw new Error('DEPARTURE_ROLLBACK_REQUIRES_PRESERVING_MANUALLY_CONFIRMED_RECORDS');
};
