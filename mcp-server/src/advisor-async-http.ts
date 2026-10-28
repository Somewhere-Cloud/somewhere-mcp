import {AsyncAdvisorController,AsyncAdvisorError,publicAsyncAdvisorRun,type AsyncAdvisorEnv} from './advisor-async';
import {sanitizeAdvisorContext,formatAdvisorContext} from './advisor-context';
import type {ToolDefinition} from './tool-registry/types';
interface Bridge {env:AsyncAdvisorEnv&{ADVISOR_ASYNC_ENABLED?:string};tools:ToolDefinition[];topics:Record<string,string>;ctx:{waitUntil(p:Promise<unknown>):void};authorize(request:Request,authorization:string):Promise<{mode:string;serviceTier:'default'|'flex';retryAfterS:number}|null>;staticAnswer(request:Request):Promise<Response>;isStatic(question:string,project:string|null,hasContext:boolean):boolean}
const response=(data:unknown,status=200):Response=>Response.json(data,{status});
/** New transport opts in explicitly; the production config remains unset. */
export async function handleAsyncAdvisorHttp(request:Request,bridge:Bridge,prepareOnly=false):Promise<Response>{
  const url=new URL(request.url),authorization=request.headers.get('Authorization')??'',capability=request.headers.get('X-Advisor-Capability')??'';
  const controller=new AsyncAdvisorController(bridge.env,bridge.topics,bridge.tools,authorization,capability);
  try{
    if(url.pathname==='/internal/advisor-observe'){
      if(request.headers.get('X-Admin-Key')!==bridge.env.SOMEWHERE_TECH_ADMIN_KEY||!bridge.env.SOMEWHERE_TECH_ADMIN_KEY)return response({ok:false,error:'FORBIDDEN'},403);
      const observer=new AsyncAdvisorController(bridge.env,bridge.topics,bridge.tools,'','',true);
      const ids=await observer.pending();const job=Promise.allSettled(ids.map(id=>observer.advance(id,true)));bridge.ctx.waitUntil(job);const settled=await job;await observer.sweep();
      return response({ok:true,data:{observed:ids.length,settled:settled.filter(r=>r.status==='fulfilled'&&r.value.result!==null).length,errors:settled.filter(r=>r.status==='rejected').length}});
    }
    if(url.pathname==='/advisor/runs'&&request.method==='POST'){
      const original=request.clone() as Request,body=await request.json<Record<string,unknown>>(),question=typeof body.question==='string'?body.question.trim():'';
      if(!question||question.length>6000||typeof body.request_id!=='string'||typeof body.request_created_at!=='number')return response({ok:false,error:'VALIDATION_ERROR',message:'question, stable request_id and request_created_at are required.'},400);
      const rawContext=body.context!==null&&typeof body.context==='object'?body.context as Record<string,unknown>:null;
      if(body.project_id!==undefined&&body.project_id!==null||rawContext?.project_ref!==undefined&&rawContext.project_ref!==null)return response({ok:false,error:'ADVISOR_PROJECT_CONTEXT_UNSUPPORTED',message:'Advisor cannot read project context. Send the needed facts explicitly as context.'},400);
      const context=sanitizeAdvisorContext(body.context),project=null;
      if(context?.file)return response({ok:false,error:'ADVISOR_CONTEXT_UNSUPPORTED',message:'Durable Advisor does not accept file excerpts. Put the relevant diagnostic or question in the request instead.'},400);
      if(bridge.isStatic(question,project,context!==null))return bridge.staticAnswer(original);
      const access=await bridge.authorize(request,authorization);if(!access)return response({ok:false,error:'UNAUTHORIZED',message:'The supplied credential is invalid.'},401);
      if(access.retryAfterS>0&&bridge.env.ADVISOR_ASYNC_ENABLED==='true')return response({ok:false,error:'RATE_LIMITED',retry_after_seconds:access.retryAfterS},429);
      const run=await controller.start({request_id:body.request_id,request_created_at:body.request_created_at,question,project_id:null,snapshot:null,diagnostic:formatAdvisorContext(context),caller:/somewhere-cli/i.test(request.headers.get('User-Agent')??'')?'cli':'unknown',surface:'full',service_tier:access.serviceTier});
      if(!prepareOnly&&bridge.env.ADVISOR_ASYNC_ENABLED==='true')bridge.ctx.waitUntil(controller.advance(run.id,true).catch(()=>undefined));return response({ok:true,data:{...publicAsyncAdvisorRun(run),...(prepareOnly&&!authorization?{anonymous_capability:capability}:{})}},202);
    }
    const match=url.pathname.match(/^\/advisor\/runs\/([a-f0-9-]{36})(?:\/(resume|cancel))?$/i);if(!match)return response({ok:false,error:'NOT_FOUND'},404);
    const [,id,operation]=match;
    if((operation&&request.method!=='POST')||(!operation&&request.method!=='GET'))return response({ok:false,error:'METHOD_NOT_ALLOWED'},405);
    if(operation==='cancel'){
      // Record cancellation before provider I/O; the client need not await model completion.
      // Backend masks retained project output under the revocation exception.
      const run=await controller.cancel(id);const observer=new AsyncAdvisorController(bridge.env,bridge.topics,bridge.tools,'','',true);bridge.ctx.waitUntil(observer.advance(id,false).catch(()=>undefined));return response({ok:true,data:publicAsyncAdvisorRun(run)});
    }
    const run=await controller.advance(id,operation==='resume');return response({ok:true,data:publicAsyncAdvisorRun(run)});
  }catch(error){if(error instanceof AsyncAdvisorError)return response({ok:false,error:error.code,message:error.message},error.status);return response({ok:false,error:'ADVISOR_OPERATION_UNCONFIRMED',message:'Operation is unconfirmed. Resume only the same request or run; no inference retry was attempted.'},503);}
}

/** Compatibility starts are unpaid until the client durably acknowledges its handle. */
export async function handleLegacyAsyncAdvisorHttp(request:Request,bridge:Bridge):Promise<Response>{
  try{const body=await request.json<Record<string,unknown>>(),url=new URL(request.url);url.pathname='/advisor/runs';const headers=new Headers(request.headers);if(!headers.get('Authorization'))headers.set('X-Advisor-Capability',Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join(''));const prepared=new Request(url,{method:'POST',headers,body:JSON.stringify({...body,request_id:crypto.randomUUID(),request_created_at:Date.now()})});return handleAsyncAdvisorHttp(prepared,bridge,true);}catch{return response({ok:false,error:'VALIDATION_ERROR',message:'Supply a JSON question.'},400);}
}
