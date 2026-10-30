import { Client } from 'eve/client';
import { writeFileSync } from 'node:fs';
import { GUARDIAN_HELP, MAX_JOB_INPUT, runGuardianJob } from './guardian/job.mjs';
export const client=new Client({host:process.env.EVE_URL});
export const modelConfigured=()=>Boolean(process.env.ZAI_API_KEY?.trim()&&process.env.ZAI_BASE_URL?.trim()&&process.env.ZAI_MODEL?.trim());
export async function answer(input,journal,deadline) {
 if(typeof input!=='string'||!input.trim()||input.length>MAX_JOB_INPUT) throw new Error('Input must contain 1 to 16000 characters');
 if(deadline!==undefined&&Date.now()>=deadline)throw new Error('Result deadline expired before analysis');
 const calculated=runGuardianJob(input);
 if(calculated){
  writeFileSync(journal,JSON.stringify({engine:'deterministic',phase:'answered',input,request:calculated.request,report:calculated.report,result:calculated.result}),{mode:0o600});
  return calculated.result;
 }
 if(!modelConfigured()){
  writeFileSync(journal,JSON.stringify({engine:'deterministic',phase:'answered',input,result:GUARDIAN_HELP}),{mode:0o600});
  return GUARDIAN_HELP;
 }
 const {session}=await client.sessions.create();
 writeFileSync(journal,JSON.stringify({sessionId:session.state.sessionId,phase:'sending'}),{mode:0o600});
 if(deadline!==undefined&&Date.now()>=deadline)throw new Error('Result deadline expired before model send');
 const result=await (await session.send(input)).result();
 if(result.status==='failed'||result.inputRequests.length||!result.message?.trim()) throw new Error('Turn did not return a final answer');
 writeFileSync(journal,JSON.stringify({sessionId:session.state.sessionId,phase:'answered',result:result.message}),{mode:0o600});
 return result.message;
}
