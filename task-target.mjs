export function taskTarget(env=process.env){
 const coworkerId=env.COWORKER_ID?.trim();
 if(!coworkerId||/\s/u.test(coworkerId))throw new Error('COWORKER_ID must identify your Coworker');
 const organizationId=env.SOKOSUMI_ORGANIZATION_ID?.trim()||null;
 const organizationSlug=env.SOKOSUMI_ORGANIZATION_SLUG?.trim()||null;
 if(Boolean(organizationId)!==Boolean(organizationSlug))throw new Error('Set both SOKOSUMI_ORGANIZATION_ID and SOKOSUMI_ORGANIZATION_SLUG, or leave both blank');
 if(organizationId&&/\s/u.test(organizationId))throw new Error('SOKOSUMI_ORGANIZATION_ID must be a single ID');
 if(organizationSlug&&!/^[a-zA-Z0-9_-]+$/u.test(organizationSlug))throw new Error('SOKOSUMI_ORGANIZATION_SLUG must be a valid Workspace slug');
 return {coworkerId,organizationId,taskArgs:organizationSlug?['--organization-slug',organizationSlug]:[],runtimeArgs:organizationId?['--organization-id',organizationId]:['--personal']};
}
export function isTaskForTarget(task,target){
 return (task?.coworkerId??task?.assigneeId)===target.coworkerId&&task.organizationId===target.organizationId;
}
export function assertTaskTarget(task,target){
 if(!isTaskForTarget(task,target))throw new Error('Task must match the configured Coworker and Workspace');
}
export async function verifyRuntimeTask(client,taskId,target){
 const {data:task}=await client.get(`/v1/tasks/${encodeURIComponent(taskId)}`,AbortSignal.timeout(30000));
 if(task?.id!==taskId)throw new Error('Runtime Task ID does not match');
 assertTaskTarget(task,target);
 return client;
}
// `tasks list` is requester-scoped: it shows only tasks the signed-in human created, so other
// customers' tasks never appear there. The Coworker-key listing covers every task assigned to
// this Coworker. Merge both; one failing source must not stop the other from being served.
export async function discoverTasks(sources,target,warn=()=>{}){
 const seen=new Map();let failures=0;
 for(const [label,list] of Object.entries(sources)){
  try{for(const task of await list())if(task?.id&&!seen.has(task.id))seen.set(task.id,task);}
  catch(error){failures++;warn(label,error);}
 }
 if(failures===Object.keys(sources).length)throw new Error('Every task listing failed');
 return [...seen.values()].filter(task=>isTaskForTarget(task,target));
}
