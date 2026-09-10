export interface ArchiveTarget { corpId: string; processInstanceId: string; fileId: string }

/** Fail closed: a partial or misspelled selector must never fall back to a global batch. */
export function parseArchiveTarget(args: string[]): ArchiveTarget | undefined {
  if (!args.length) return undefined;
  const values=new Map<string,string>();
  for(const arg of args) {
    const match=/^--(corp-id|instance-id|file-id)=(.+)$/.exec(arg);
    if(!match || !match[2].trim() || values.has(match[1])) throw new Error('Use --corp-id=ID --instance-id=ID --file-id=ID together, exactly once');
    values.set(match[1],match[2]);
  }
  if(values.size!==3) throw new Error('An exact attachment target requires corp-id, instance-id and file-id');
  return {corpId:values.get('corp-id')!,processInstanceId:values.get('instance-id')!,fileId:values.get('file-id')!};
}
