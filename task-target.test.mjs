import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskTarget,assertTaskTarget,verifyRuntimeTask,discoverTasks} from './task-target.mjs';

test('task listing and runtime select the same Personal or organization Workspace',()=>{
 const personal=taskTarget({COWORKER_ID:'coworker'});
 assert.deepEqual(personal,{coworkerId:'coworker',organizationId:null,taskArgs:[],runtimeArgs:['--personal']});
 const organization=taskTarget({COWORKER_ID:'coworker',SOKOSUMI_ORGANIZATION_ID:'organization',SOKOSUMI_ORGANIZATION_SLUG:'event-workspace'});
 assert.deepEqual(organization,{coworkerId:'coworker',organizationId:'organization',taskArgs:['--organization-slug','event-workspace'],runtimeArgs:['--organization-id','organization']});
 assert.doesNotThrow(()=>assertTaskTarget({coworkerId:'coworker',organizationId:null},personal));
 assert.doesNotThrow(()=>assertTaskTarget({coworkerId:'coworker',organizationId:'organization'},organization));
 assert.throws(()=>assertTaskTarget({coworkerId:'coworker',organizationId:null},organization),/configured Coworker and Workspace/);
 assert.throws(()=>assertTaskTarget({coworkerId:'coworker',organizationId:'organization'},personal),/configured Coworker and Workspace/);
});

test('incomplete or invalid Workspace settings cannot fall back to Personal Workspace',()=>{
 assert.throws(()=>taskTarget({COWORKER_ID:'coworker',SOKOSUMI_ORGANIZATION_ID:'organization'}),/Set both/);
 assert.throws(()=>taskTarget({COWORKER_ID:'coworker',SOKOSUMI_ORGANIZATION_SLUG:'event-workspace'}),/Set both/);
 assert.throws(()=>taskTarget({COWORKER_ID:'coworker',SOKOSUMI_ORGANIZATION_ID:'organization',SOKOSUMI_ORGANIZATION_SLUG:'event/workspace'}),/slug/);
 assert.throws(()=>taskTarget({}),/COWORKER_ID/);
});

test('runtime reads confirm the current Task before comments or payment operations',async()=>{
 const target={coworkerId:'coworker',organizationId:'organization'};
 let observed={id:'task',assigneeId:'coworker',organizationId:'organization'};
 const client={get:async(path)=>{assert.equal(path,'/v1/tasks/task');return {data:observed};}};
 assert.equal(await verifyRuntimeTask(client,'task',target),client);
 for(const change of [{id:'another-task'},{assigneeId:'another-coworker'},{organizationId:null}]){
  const previous=observed;observed={...observed,...change};
  await assert.rejects(verifyRuntimeTask(client,'task',target),/Runtime Task ID|configured Coworker and Workspace/);
  observed=previous;
 }
});

test('worker discovers other customers\' tasks through the Coworker listing and survives one failed source',async()=>{
 const target={coworkerId:'coworker',organizationId:'organization'};
 const own={id:'own',coworkerId:'coworker',organizationId:'organization'};
 const customer={id:'customer',coworkerId:'coworker',organizationId:'organization'};
 const foreign={id:'foreign',coworkerId:'another-coworker',organizationId:'organization'};
 const tasks=await discoverTasks({requester:async()=>[own],coworker:async()=>[own,customer,foreign]},target);
 assert.deepEqual(tasks.map(t=>t.id),['own','customer']);
 const warnings=[];
 const fallback=await discoverTasks({requester:async()=>[own],coworker:async()=>{throw new Error('403')}},target,label=>warnings.push(label));
 assert.deepEqual(fallback.map(t=>t.id),['own']);assert.deepEqual(warnings,['coworker']);
 await assert.rejects(discoverTasks({requester:async()=>{throw new Error('down')}},target),/Every task listing failed/);
});
