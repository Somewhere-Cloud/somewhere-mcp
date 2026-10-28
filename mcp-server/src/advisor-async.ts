import {advisorWorkflows} from './advisor-workflows';
import {ADVISOR_SYSTEM_POLICY} from './advisor-system-policy';
import {ADVISOR_CONTEXT_SECURITY_POLICY} from './advisor-boundary';
import {ADVISOR_COMPOSITION_PROMPT,parseAdvisorComposition,renderAdvisorComposition,advisorAuthFlowRequested} from './advisor-composition';
import {ADVISOR_FOUNDATION_TOPICS,readAdvisorDocs} from './advisor-docs-retrieval';
import {buildAdvisorRequestBody,selectAdvisorRequestKnowledge} from './advisor-request';
import {checkAdvisorCommands,checkAdvisorDocsTopics} from './advisor-command-contract';
import {redactAdvisorContextText} from './advisor-context';
import type {ToolDefinition} from './tool-registry/types';
export interface AsyncAdvisorEnv {ADVISOR_ASYNC_ENABLED?:string;OPENAI_API_KEY?:string;SOMEWHERE_TECH_ADMIN_KEY?:string;API_SERVICE:{fetch(request:Request):Promise<Response>}}
interface DocRead {call_id:string;requested:string[];included:string[];omitted:Array<{topic:string;reason:string}>}
interface Round {billing_settled?:boolean;contract_version?:number;auth_flow_requested?:boolean;selected_topics?:string[];omitted_contracts?:Array<{topic:string;reason:string}>;docs_versions?:Record<string,string>;prefix_hash?:string;tool_names?:string[];tool_contract_hash?:string;caller?:string;surface?:string;number:number;fingerprint:string;status:string;provider_id:string|null;observation_error:string|null;last_observed_at:number|null;started_at?:number;output:unknown;usage:unknown;input_tokens?:number;tokenizer_input_tokens?:number;protocol_token_allowance?:number;output_limit?:number;doc_reads?:DocRead[];account_reads?:string[];served_model?:string;service_tier?:string;request_id?:string|null;incomplete_details:unknown}
export interface AsyncRun {id:string;owner_scope:string;request_fingerprint:string;project_id:string|null;revision:number;cancel_requested:boolean;max_rounds:number;question:string|null;principal:Record<string,unknown>|null;input:RunInput|null;input_expires_at:number;rounds:Round[];result:RunResult|null;created_at:number;payload_expired?:boolean;continuation_authorized?:boolean}
interface RunInput {contract_version?:number;auth_flow_requested?:boolean;selected_topics?:string[];omitted_contracts?:Array<{topic:string;reason:string}>;tool_names:string[];tool_contract_hash:string;question:string;snapshot:string|null;account?:string|null;diagnostic:string|null;caller:string;surface:string;prefix_hash:string;docs_versions:Record<string,string>;config:{model:'gpt-6.1-sol';effort:'low';cold_budget_cents:number;max_input_tokens:number;max_rounds:number;service_tier:'default'|'flex'}}
export interface RunResult {answer:string;error?:string;model:string;cost_cents:number|null;usage_status:string;incomplete:boolean;omitted_contracts:Array<{topic:string;reason:string}>;partial_output?:string;context_expired?:boolean}
export class AsyncAdvisorError extends Error {constructor(public readonly code:string,public readonly status:number,message:string){super(message);}}
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const terminal=(s:string):boolean=>['completed','failed','incomplete','cancelled'].includes(s);
const output=(v:unknown):Array<Record<string,unknown>>=>Array.isArray(v)?v.map(object).filter((x):x is Record<string,unknown>=>x!==null&&['message','function_call','reasoning'].includes(String(x.type))):[];
const text=(v:unknown):string=>output(v).filter(x=>x.type==='message').flatMap(x=>Array.isArray(x.content)?x.content:[]).map(object).filter((x):x is Record<string,unknown>=>x!==null&&x.type==='output_text'&&typeof x.text==='string').map(x=>x.text).join('\n');
const hash=async(s:string):Promise<string>=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
function usage(r:Round):{input:number;out:number;cached:number;write:number;reasoning:number}|null {const u=object(r.usage),details=object(u?.input_tokens_details),out=object(u?.output_tokens_details);const values=[u?.input_tokens,u?.output_tokens,details?.cached_tokens??0,details?.cache_write_tokens??0,out?.reasoning_tokens??0];if(!values.every(v=>Number.isSafeInteger(v)&&Number(v)>=0)||Number(values[2])+Number(values[3])>Number(values[0]))return null;return {input:Number(values[0]),out:Number(values[1]),cached:Number(values[2]),write:Number(values[3]),reasoning:Number(values[4])};}
/** Cache warmth never extends authority: cold charges all input at write rate. */
/** Internal whole-topic packing ceiling for the docs body. Not an admission control: every round is
 * still refused above config.max_input_tokens or the cold budget, counted on the exact provider body. */
export const ADVISOR_DOCS_PACK_MAX_BYTES=300000;
const coldCents=(input:number,out:number):number=>(input*2.5+out*10)/10000;
export class AsyncAdvisorController {
  constructor(private readonly env:AsyncAdvisorEnv,private readonly topics:Record<string,string>,private readonly tools:ToolDefinition[],private readonly authorization='',private readonly capability='',private readonly observer=false,private readonly fetcher:typeof fetch=fetch.bind(globalThis)){}
  private async receipt<T>(body:Record<string,unknown>):Promise<T>{
    const r=await this.env.API_SERVICE.fetch(new Request('https://api-internal/v1/sys/advisor-receipts',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':this.env.SOMEWHERE_TECH_ADMIN_KEY??'',...(this.authorization?{Authorization:this.authorization}:{}),...(this.capability?{'X-Advisor-Capability':this.capability}:{}),...(this.observer?{'X-Advisor-Observer':'1'}:{})},body:JSON.stringify(body)}));
    const j=await r.json<{ok?:boolean;data?:T;error?:string;message?:string}>();if(!r.ok||!j.ok)throw new AsyncAdvisorError(j.error??'ADVISOR_RECEIPT_UNAVAILABLE',r.status,j.message??'Resume the same request or run.');return j.data as T;
  }
  private knowledge(question:string,caller:string){
    const selected=selectAdvisorRequestKnowledge(question,this.topics,this.tools,{caller});
    return readAdvisorDocs([...new Set([...ADVISOR_FOUNDATION_TOPICS,...advisorWorkflows(question).flatMap(workflow=>[...workflow.topics]),...selected.topics,'declared-data','sw.db','sw.groups'])],this.topics,this.tools,ADVISOR_DOCS_PACK_MAX_BYTES,caller);
  }
  private prefix(docs:string):string{return [ADVISOR_SYSTEM_POLICY,ADVISOR_CONTEXT_SECURITY_POLICY,ADVISOR_COMPOSITION_PROMPT,docs,'Advice only from the question, caller-provided context and public contracts. No project/account access, tools or additional inference is available. Caller facts are unverified. Omitted whole contracts are unknown coverage; ask for needed context in a new explicit question.'].join('\n\n');}
  async start(args:{request_id:string;request_created_at:number;question:string;project_id:string|null;snapshot:string|null;diagnostic:string|null;caller:string;surface:string;service_tier:'default'|'flex';cold_budget_cents?:number;account?:string|null}):Promise<AsyncRun>{
    if(args.project_id!==null||args.snapshot||args.account)throw new AsyncAdvisorError('ADVISOR_PROJECT_CONTEXT_UNSUPPORTED',400,'Advisor cannot read project or account context. Supply needed facts explicitly as context.');
    const fingerprint=await hash(JSON.stringify({question:args.question,project_id:args.project_id,diagnostic:args.diagnostic,caller:args.caller,surface:args.surface,request_created_at:args.request_created_at,service_tier:args.service_tier,cold_budget_cents:args.cold_budget_cents??50}));
    const existing=await this.receipt<AsyncRun|null>({action:'find',request_id:args.request_id,fingerprint});if(existing)return existing;
    if(this.env.ADVISOR_ASYNC_ENABLED!=='true')throw new AsyncAdvisorError('ADVISOR_ASYNC_NOT_ENABLED',503,'New durable Advisor requests are disabled. Existing run controls remain available.');
    if(!Number.isSafeInteger(args.request_created_at)||args.request_created_at>Date.now()+120000||args.request_created_at<Date.now()-300000)throw new AsyncAdvisorError('ADVISOR_REQUEST_EXPIRED',400,'This new request timestamp is stale. Resume its existing run; do not retry inference with a fresh identity automatically.');
    const budget=args.cold_budget_cents??50;if(!Number.isFinite(budget)||budget<=0||budget>100)throw new AsyncAdvisorError('ADVISOR_BUDGET_INVALID',400,'Candidate cold budget must be at most $1.');
    const question=redactAdvisorContextText(args.question),docs=this.knowledge(question,args.caller),prefix=this.prefix(docs.text);
    const input:RunInput={contract_version:2,auth_flow_requested:advisorAuthFlowRequested(question),selected_topics:docs.included,omitted_contracts:docs.omitted,tool_names:this.tools.map(tool=>tool.name),tool_contract_hash:await hash(JSON.stringify(this.tools)),question,snapshot:null,diagnostic:args.diagnostic?redactAdvisorContextText(args.diagnostic):null,caller:args.caller,surface:args.surface,prefix_hash:await hash(prefix),docs_versions:Object.fromEntries(await Promise.all(docs.included.map(async topic=>[topic,await hash(this.topics[topic])]))),config:{model:'gpt-6.1-sol',effort:'low',cold_budget_cents:budget,max_input_tokens:80000,max_rounds:1,service_tier:args.service_tier}};
    return this.receipt<AsyncRun>({action:'admit',request_id:args.request_id,fingerprint,project_id:null,max_rounds:1,input});
  }

  private toolsFor(run:AsyncRun):ToolDefinition[]{const names=run.rounds[0].tool_names??run.input?.tool_names??[];const available=new Map(this.tools.map(tool=>[tool.name,tool]));return names.map(name=>available.get(name)).filter((tool):tool is ToolDefinition=>tool!==undefined);}
  private async checkTools(run:AsyncRun):Promise<void>{if(await hash(JSON.stringify(this.toolsFor(run)))!==(run.rounds[0].tool_contract_hash??run.input?.tool_contract_hash))throw new AsyncAdvisorError('ADVISOR_TOOL_VERSION_UNAVAILABLE',409,'The originally advertised tool contract is unavailable; no broader or replacement tools were used.');}
  async read(id:string):Promise<AsyncRun>{return this.receipt<AsyncRun>({action:'read',run_id:id});}
  async pending():Promise<string[]>{return this.receipt<string[]>({action:'list_pending'});}
  async sweep():Promise<void>{await this.receipt({action:'sweep'});}
  private async request(path:string,method:string,body?:Record<string,unknown>):Promise<{status:number;request_id:string|null;value:Record<string,unknown>}>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    try{const r=await this.fetcher('https://api.openai.com/v1/'+path,{method,headers:{Authorization:'Bearer '+this.env.OPENAI_API_KEY,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal});const value:unknown=await r.json();return {status:r.status,request_id:r.headers.get('x-request-id'),value:object(value)??{}};}finally{clearTimeout(timer);}
  }
  private async body(run:AsyncRun):Promise<Record<string,unknown>>{
    const input=run.input!;
    const docs=readAdvisorDocs(input.selected_topics??[],this.topics,this.toolsFor(run),Number.MAX_SAFE_INTEGER,input.caller);
    // Admission's whole-topic coverage and omission record is immutable.
    const docsText=docs.text.replace(/## Retrieval coverage\n[\s\S]*$/, '## Retrieval coverage\n'+JSON.stringify({included:input.selected_topics,omitted:input.omitted_contracts,contract_coverage_complete:(input.omitted_contracts??[]).length===0,omitted_contracts_are_unknown:true,not_missing_project_inputs:true}));
    const prefix=this.prefix(docsText);
    if(await hash(prefix)!==input.prefix_hash)throw new AsyncAdvisorError('ADVISOR_DOCS_VERSION_UNAVAILABLE',409,'Original public contract prefix is unavailable. No replacement inference was sent.');
    const body=buildAdvisorRequestBody(input.config.model,prefix,input.question,input.diagnostic,input.prefix_hash,input.config.service_tier);
    return {...body,reasoning:{effort:'low'},background:true,store:false,max_output_tokens:12000};
  }
  private async count(body:Record<string,unknown>):Promise<number>{const {model,input,text,reasoning}=body;const r=await this.request('responses/input_tokens','POST',{model,input,text,reasoning});if(r.status!==200||(!Number.isSafeInteger(r.value.input_tokens)||Number(r.value.input_tokens)<0))throw new AsyncAdvisorError('ADVISOR_TOKEN_COUNT_UNAVAILABLE',503,'Token admission is unavailable. No inference was dispatched. Resume the same run.');// Real Responses usage exceeded the counter by four framing tokens in both probe rounds.
    return Number(r.value.input_tokens)+32;}
  private async checkVersions(run:AsyncRun,names:string[]):Promise<void>{
    if(!run.input)throw new AsyncAdvisorError('ADVISOR_INPUT_EXPIRED',409,'Original reconstruction context is unavailable.');
    for(const name of [...new Set(names)])if(run.input.docs_versions[name]!==await hash(this.topics[name]??''))throw new AsyncAdvisorError('ADVISOR_DOCS_VERSION_UNAVAILABLE',409,'Original complete-contract version is unavailable. No replacement inference was sent.');
  }
  private async dispatch(run:AsyncRun):Promise<AsyncRun>{
    if(run.rounds[0].contract_version!==2||run.rounds.length!==1)return this.finish(run,'legacy_request_retry_required','This unpaid prepared request uses the old contract. Submit a new explicit question; no inference was started.');
    if(this.env.ADVISOR_ASYNC_ENABLED!=='true')return this.finish(run,'async_disabled','New Advisor inference rounds are disabled. No replacement inference was started.');
    const round=run.rounds.at(-1)!;if(!run.input||run.input_expires_at<=Date.now())return this.finish(run,'input_expired','Reconstruction context expired. The known response may still be observed; no new inference will be started.');
    if(run.continuation_authorized===false)return this.finish(run,'authority_revoked','Project/account authority was removed; no new round was started.');
    try{await this.checkVersions(run,run.input.selected_topics??[]);}catch(error){if(error instanceof AsyncAdvisorError)return this.finish(run,'docs_version_unavailable',error.message);throw error;}
    try{await this.checkTools(run);}catch(error){if(error instanceof AsyncAdvisorError)return this.finish(run,'tool_version_unavailable',error.message);throw error;}
    let body:Record<string,unknown>;
    try{body=await this.body(run);}catch(error){if(error instanceof AsyncAdvisorError)return this.finish(run,'docs_version_unavailable',error.message);throw error;}
    const tokens=await this.count(body),limit=Number(body.max_output_tokens);
    if(tokens>run.input.config.max_input_tokens||coldCents(tokens,limit)>run.input.config.cold_budget_cents)return this.finish(run,'budget_exhausted','The frozen cold budget cannot admit this complete-context round. Omitted contracts remain unknown.');
    await this.receipt({action:'configure',run_id:run.id,round:round.number,metadata:{input_tokens:tokens,tokenizer_input_tokens:tokens-32,protocol_token_allowance:32,output_limit:limit}});
    if(this.env.ADVISOR_ASYNC_ENABLED!=='true')return this.finish(run,'async_disabled','New Advisor inference rounds are disabled. No new provider request was started.');
    const claim=await this.receipt<{claimed:boolean;receipt:AsyncRun}>({action:'claim',run_id:run.id,round:round.number});if(!claim.claimed)return claim.receipt;
    try{
      const response=await this.request('responses','POST',body);
      if([400,401,403,404,422].includes(response.status)){
        const failed=await this.receipt<AsyncRun>({action:'observe',run_id:run.id,round:round.number,observation:{status:'failed',provider_id:null,last_observed_at:Date.now(),output:null,usage:null,request_id:response.request_id}});
        return this.finish(failed,'provider_rejected','The provider rejected this request (HTTP '+response.status+'). No inference retry or model substitution was attempted.');
      }
      if(response.status!==200)throw new Error('Provider acknowledgment unconfirmed');
      return await this.observe(claim.receipt,round,response.value,response.request_id);
    }catch(error){
      if(error instanceof AsyncAdvisorError)throw error;
      const unknown=await this.receipt<AsyncRun>({action:'observation_error',run_id:run.id,round:round.number,error:'create_unconfirmed'});
      return this.finish(unknown,'create_unconfirmed','Provider dispatch is unconfirmed and may already be billable. Resume or cancel this run; do not start a replacement inference automatically.');
    }
  }
  private async observe(run:AsyncRun,round:Round,p:Record<string,unknown>,requestId:string|null):Promise<AsyncRun>{
    if(typeof p.id!=='string'||!p.id.startsWith('resp_')||!['queued','in_progress','completed','failed','incomplete','cancelled'].includes(String(p.status)))throw new Error('Provider response invalid');
    return this.receipt<AsyncRun>({action:'observe',run_id:run.id,round:round.number,observation:{status:p.status,provider_id:p.id,last_observed_at:Date.now(),output:this.expired(run)?null:output(p.output).filter(item=>run.rounds[0].contract_version!==2||item.type!=='reasoning'),usage:p.usage??null,incomplete_details:['max_output_tokens','content_filter'].includes(String(object(p.incomplete_details)?.reason))?{reason:object(p.incomplete_details)!.reason}:null,request_id:requestId,served_model:p.model,service_tier:p.service_tier}});
  }
  async advance(id:string,allowNext:boolean):Promise<AsyncRun>{
    let run=await this.read(id);let round=run.rounds.at(-1)!;
    if(run.result&&(!round.provider_id||terminal(round.status))){
      if(run.rounds[0].contract_version===2&&round.provider_id&&terminal(round.status)&&round.billing_settled!==true)return this.finish(run);
      return run;
    }
    if(round.status==='prepared'&&run.rounds[0].contract_version!==2)return this.finish(run,'legacy_request_retry_required','This unpaid prepared request uses the old contract. Submit a new explicit question; no inference was started.');
    if(round.status==='prepared')return allowNext?this.dispatch(run):run;
    if(round.provider_id&&!terminal(round.status)){
      try{const p=await this.request('responses/'+encodeURIComponent(round.provider_id)+(run.cancel_requested?'/cancel':''),run.cancel_requested?'POST':'GET');
        if(p.status===404){run=await this.receipt({action:'observation_error',run_id:id,round:round.number,error:'response_unavailable'});return this.finish(run,'response_unavailable','The original provider response is unavailable before local completion capture. Its compute/billing status is not confirmed; no replacement inference was sent.');}
        if(p.status!==200)throw Error('Observation failed');run=await this.observe(run,round,p.value,p.request_id);round=run.rounds.at(-1)!;
      }catch(error){if(error instanceof AsyncAdvisorError)throw error;return this.receipt({action:'observation_error',run_id:id,round:round.number,error:run.cancel_requested?'cancel_failed':'retrieve_failed'});}
    }
    if(!terminal(round.status))return run;
    if(round.served_model&&round.served_model!=='gpt-6.1-sol')return this.finish(run,'unexpected_model','The provider returned an unexpected model. No replacement inference was sent.',text(round.output));
    if(round.status!=='completed')return this.finish(run,'provider_'+round.status,'The provider response is '+round.status+'. Partial output and usage are retained explicitly.',text(round.output));
    if(output(round.output).some(item=>item.type==='function_call'))return this.finish(run,'invalid_tool_call','The provider returned an unexpected function call. It was not executed and no further inference was started.');
    return this.finish(run);
  }

  async cancel(id:string):Promise<AsyncRun>{return this.receipt<AsyncRun>({action:'cancel',run_id:id});}
  private expired(run:AsyncRun):boolean{return run.payload_expired===true||run.input_expires_at<=Date.now();}
  private async finish(run:AsyncRun,error?:string,message?:string,partial?:string):Promise<AsyncRun>{
    const originalQuestion=run.question??run.input?.question??null,v2=run.rounds[0].contract_version===2,contextExpired=v2?this.expired(run):originalQuestion===null;let missingValidation=false;let answer=message??'',cost:number|null=0,inputTokens=0,outputTokens=0;
    for(const round of run.rounds){if(!round.started_at)continue;const u=usage(round);if(!u||round.served_model!=='gpt-6.1-sol'||!['default','flex'].includes(round.service_tier??'')){cost=null;continue;}inputTokens+=u.input;outputTokens+=u.out;const priced=((u.input-u.cached-u.write)*2+u.cached*.1+u.write*2.5+u.out*10)/10000*(round.service_tier==='flex'?.5:1);if(cost!==null)cost+=priced;}
    if(!v2&&contextExpired&&!error){error='input_expired';answer='Original request context expired. The known provider response was settled, but its guidance could not be validated for delivery.';}
    if(v2&&typeof run.rounds[0].auth_flow_requested!=='boolean'&&!error){error='intent_unavailable';answer='The saved request intent is invalid. Its output was withheld.';}
    if(!error&&!contextExpired){try{await this.checkTools(run);}catch{error='tool_version_unavailable';answer='The provider completed, but the original advertised tool contract is unavailable for validation. Its output was retained; no broader tools were substituted.';partial=text(run.rounds.at(-1)!.output);}}
    if(!error&&!contextExpired){
      const raw=text(run.rounds.at(-1)!.output),composition=parseAdvisorComposition(raw);
      if(!composition){error='invalid_output';answer='The provider returned invalid composition. Partial output is retained as incomplete, not executable guidance.';partial=raw;}
      else{if(!v2&&contextExpired&&composition.recipes.some(recipe=>recipe.kind==='magic_link_browser')){composition.recipes=composition.recipes.filter(recipe=>recipe.kind!=='magic_link_browser');missingValidation=true;partial=raw;}const rendered=renderAdvisorComposition(composition,{tools:this.toolsFor(run),projectId:run.project_id,caller:run.rounds[0].caller??run.input?.caller??'unknown',...(v2?{authFlowRequested:run.rounds[0].auth_flow_requested}:{question:originalQuestion??undefined})});const commands=checkAdvisorCommands(rendered.text,this.toolsFor(run)),refs=checkAdvisorDocsTopics(rendered.text,t=>Object.hasOwn(this.topics,t));if(!commands.ok||!refs.ok){error='invalid_output';answer='The answer contains an unverified command or documentation reference. It was withheld.';partial=raw;}else answer=rendered.text;}
    }
    if(missingValidation)answer+='\n\nThe authentication recipe was withheld because its original request intent is unavailable after context retention expired. Other validated guidance is preserved.';
    const omissions=v2?(run.rounds[0].omitted_contracts??[]):run.rounds.flatMap(round=>round.doc_reads?.flatMap(read=>read.omitted)??[]).filter(o=>!run.rounds.some(round=>round.doc_reads?.some(read=>read.included.includes(o.topic))));
    if(omissions.length)answer+='\n\nUnread complete contracts (coverage unknown): '+omissions.map(o=>o.topic+' ['+o.reason+']').join(', ')+'.';
    if(contextExpired&&v2){answer='Advisor payload delivery expired. Known provider work remains observable and cancellable until its outcome and billing are settled.';partial=undefined;}
    const result:RunResult={answer,model:'gpt-6.1-sol',cost_cents:cost,usage_status:cost===null?'unconfirmed_or_unpriced':'token_estimate',incomplete:Boolean(error)||missingValidation||omissions.length>0,omitted_contracts:omissions,...(contextExpired?{context_expired:true}:{}),...(error?{error}:{}),...(partial?{partial_output:partial}:{} )};
    return this.receipt<AsyncRun>({action:'finish',run_id:run.id,result,audit:{model:'gpt-6.1-sol',cost_cents:cost,input_tokens:inputTokens,output_tokens:outputTokens,calls:run.rounds.filter(r=>r.started_at!==undefined).length,diagnostics:{status:error??'completed',payload_expired:v2&&contextExpired,usage_status:result.usage_status,contract_version:run.rounds[0].contract_version??1,selected_topics:run.rounds[0].selected_topics??[],docs_versions:run.rounds[0].docs_versions??{},omitted_contracts:omissions}}});
  }
}
export function publicAsyncAdvisorRun(run:AsyncRun):Record<string,unknown>{
  const round=run.rounds.at(-1)!,expired=run.payload_expired===true||run.input_expires_at<=Date.now();
  return {run_id:run.id,status:expired?'payload_expired':run.result?'settled':round.status,provider_status:round.status,last_observed_at:round.last_observed_at,cancel_requested:run.cancel_requested,observation_error:round.observation_error,retry_after_seconds:2,payload_expires_at:run.input_expires_at,payload_expired:expired,model:run.input?.config.model??run.result?.model??'gpt-6.1-sol',...(run.result?(expired?{cost_cents:run.result.cost_cents,usage_status:run.result.usage_status,incomplete:run.result.incomplete,...(run.result.error?{error:run.result.error}:{})}:run.result):{}),next_step:round.provider_id&&!terminal(round.status)?'status':run.result?'none':round.status==='prepared'||round.status==='completed'?'resume':'status'};
}
