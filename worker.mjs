import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {userInfo} from 'node:os';
import {acquireWorkerLock} from './worker-lock.mjs';
import {answer,client,modelConfigured} from './client.mjs';
import {reply} from './comments.mjs';
import {createPaidAdapter,isPaidReady} from './paid-task.mjs';
import {loadSokosumiRuntime} from './sokosumi-runtime.mjs';
import {taskTarget,discoverTasks} from './task-target.mjs';
import {runGuardianJob,dashboardUrl,dashboardWelcome} from './guardian/job.mjs';
import {validatePaidWorkerMode,validateWorkerOperator,isLoopbackUrl} from './guardian/worker-config.mjs';
validateWorkerOperator(process.env.WORKER_OPERATOR,userInfo().username);
const target=taskTarget();
const id=target.coworkerId;
const paidEnabled=validatePaidWorkerMode(process.env.PAID_TASKS_ENABLED,process.env.PAID_TASKS_ENABLED==='true'&&isPaidReady());
const releaseLock=acquireWorkerLock();
process.once('exit',releaseLock);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{releaseLock();process.exit(0)});
function cli(args){return JSON.parse(execFileSync('sokosumi',['--preprod',...args,'--json'],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}));}
const {readRuntimeCredential,createCoworkerHttpClient,fetchTasks,createTaskEvent}=await loadSokosumiRuntime();
const runtime=createCoworkerHttpClient({apiKey:readRuntimeCredential(id)});
const warned=new Set();
function warnOnce(label,error){const key=`${label}:${error.message}`;if(!warned.has(key)){warned.add(key);console.warn(`Task listing (${label}) failed; continuing with the other source:`,error.message.slice(0,200));}}
async function welcome(t,state,journal){
 if(state.welcome)return state;
 state={...state,welcome:'pending'};writeFileSync(journal,JSON.stringify(state),{mode:0o600});
 try{await createTaskEvent(runtime,t.id,{comment:dashboardWelcome()},AbortSignal.timeout(30000));state={...state,welcome:'posted'};console.log('Dashboard link sent',t.id);}
 catch(e){state={...state,welcome:'failed'};console.error('Dashboard link not sent',t.id,e.message.slice(0,200));}
 writeFileSync(journal,JSON.stringify(state),{mode:0o600});return state;
}
if(modelConfigured())await client.health();
if(isLoopbackUrl(dashboardUrl()))console.warn(`DASHBOARD_URL is ${dashboardUrl()}; customers cannot open it. Set it to the public dashboard URL.`);
const paid=await createPaidAdapter({target,answer,save:async(taskId,state)=>writeFileSync(`.local/${taskId}.json`,JSON.stringify(state),{mode:0o600})});
console.log('Continuous worker running',process.pid,'| dashboard',dashboardUrl());
while(true){
 try{
 const tasks=await discoverTasks({
  requester:async()=>cli(['tasks','list','--coworker-id',id,...target.taskArgs]).tasks,
  coworker:async()=>(await fetchTasks(runtime,{coworkerId:id},AbortSignal.timeout(30000))).tasks,
 },target,warnOnce);
 for(const t of tasks){
 try{
 const journal=`.local/${t.id}.json`,resultFile=`.local/${t.id}.txt`;
 let state=existsSync(journal)?JSON.parse(readFileSync(journal,'utf8')):{};
 if(t.status==='READY'&&!state.phase){writeFileSync(journal,JSON.stringify({phase:'starting'}),{mode:0o600});const started=cli(['runtime','start',t.id,...target.runtimeArgs,'--coworker-id',id]);state={phase:'started',input:started.description};writeFileSync(journal,JSON.stringify(state),{mode:0o600});console.log('Started',t.id);}
 if(state.phase==='started'&&!state.paid)state=await welcome(t,state,journal);
 if(state.paid&&!paidEnabled)continue;
 if(state.paid||(state.phase==='started'&&paidEnabled)){
 if(!state.paid&&!runGuardianJob(state.input)&&!modelConfigured())throw Error('Paid analysis requires a position JSON object or "guardian demo" when no model is configured');
 state=await paid.advance(t,state);if(state.phase==='completed')await reply(t);continue;
 }
 if(state.phase==='started'){
 writeFileSync(journal,JSON.stringify({...state,phase:'model-pending'}),{mode:0o600});
 const result=await answer(state.input,`.local/${t.id}-session.json`);
 writeFileSync(resultFile,result,{mode:0o600});state={...state,phase:'result-saved'};writeFileSync(journal,JSON.stringify(state),{mode:0o600});
 }
 if(state.phase==='result-saved'){
 writeFileSync(journal,JSON.stringify({...state,phase:'complete-pending'}),{mode:0o600});
 const completed=cli(['runtime','complete',t.id,...target.runtimeArgs,'--coworker-id',id,'--result-file',resultFile]);
 writeFileSync(journal,JSON.stringify({...state,phase:'completed',completion:completed}),{mode:0o600});console.log('Completed',t.id);
 }
 if(state.phase==='completed')await reply(t);
 }catch(e){console.error('Task blocked',t.id,e.message.slice(0,200))}
 }
 }catch(e){console.error('Polling read failed',e.message.slice(0,200))}
 await new Promise(r=>setTimeout(r,5000));
}
