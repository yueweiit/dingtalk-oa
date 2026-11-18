export interface ArchiveTarget {
  corpId: string;
  processInstanceId: string;
  fileId: string;
}

export interface ArchiveTemplateTarget {
  corpId: string;
  processCode: string;
  enqueueOnly: boolean;
}

export interface ArchiveCorpTarget {
  corpId: string;
  allTemplates: true;
  enqueueOnly: boolean;
}

const usage = 'Use --corp-id=ID with --instance-id=ID --file-id=ID, or with --process-code=CODE / --all-templates [--enqueue-only]';

/** Fail closed: a partial or misspelled selector must never fall back to a global batch. */
export function parseArchiveTarget(args: string[]): ArchiveTarget | ArchiveTemplateTarget | ArchiveCorpTarget | undefined {
  if (!args.length) return undefined;
  const values = new Map<string, string>();
  let enqueueOnly = false;
  let allTemplates = false;
  for (const arg of args) {
    if (arg === '--enqueue-only' && !enqueueOnly) {
      enqueueOnly = true;
      continue;
    }
    if (arg === '--all-templates' && !allTemplates) {
      allTemplates = true;
      continue;
    }
    const match = /^--(corp-id|instance-id|file-id|process-code)=(.+)$/.exec(arg);
    if (!match || !match[2].trim() || values.has(match[1])) throw new Error(usage);
    values.set(match[1], match[2]);
  }

  const corpId = values.get('corp-id');
  const processInstanceId = values.get('instance-id');
  const fileId = values.get('file-id');
  const processCode = values.get('process-code');
  if (corpId && processInstanceId && fileId && values.size === 3 && !enqueueOnly && !allTemplates) {
    return { corpId, processInstanceId, fileId };
  }
  if (corpId && processCode && values.size === 2 && !allTemplates) return { corpId, processCode, enqueueOnly };
  if (corpId && allTemplates && values.size === 1) return { corpId, allTemplates: true, enqueueOnly };
  throw new Error(usage);
}
