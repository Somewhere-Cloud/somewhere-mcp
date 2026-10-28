import { ADVISOR_TOPIC_SUMMARIES } from './advisor-topic-catalog';
import { ADVISOR_TOPIC_DEPENDENCIES } from './platform-help';
import { selectAdvisorKnowledge } from './advisor-knowledge';
import type { ToolDefinition } from './tool-registry/types';
export const ADVISOR_FOUNDATION_TOPICS = ['guarantees','sdk','security-model','sw.endpoint'] as const;
const CROSS_FEATURE_POINTERS: Readonly<Record<string,readonly string[]>> = {
  'browser authentication':['sw.auth','auth-client','security-model','browser'],
  'auth/email testing':['sw.auth','browser','sw.email','inbox','cli'],
  'data and ownership':['declared-data','sw.db','security-model'],
  'file sharing':['declared-files','sw.fs','security-model'],
  'live feed':['live','live-data','declared-data','sw.auth'],
  'durable and background work':['sw.jobs','cron','sw.db'],
  'AI and media':['sw.ai','sw.agent','sw.jobs','sw.fs'],
  'external requests':['sw.fetch','sw.web','security-model'],
  notifications:['sw.notifications','sw.push','sw.email','sw.auth'],
  'payments and durable state':['payments','sw.db','sw.env','browser','dev-environments'],
  calendar:['calendar','payments','sw.db'],
  'application versus platform billing':['sw.billing','billing','pricing'],
  'local deploy preview configuration':['deploy','local-dev','dev-environments','sw.env','verify-before-deploy','cli'],
  'domains sessions origins':['domains','domain-ownership','cors','auth-client'],
  diagnosis:['inspect','sw.logs','troubleshooting'],
  portability:['portability','postgres','migration-supabase','sw.db'],
};
const bytes=(text:string):number=>new TextEncoder().encode(text).byteLength;
/** Stable public prefix comes from maintained current contracts. Private project
 * facts and the question must be supplied after its explicit cache breakpoint. */
export function advisorDocsFoundation(topics:Readonly<Record<string,string>>):string {
  return '# STABLE PLATFORM FOUNDATION\n'+ADVISOR_FOUNDATION_TOPICS.map(name=>{
    if(!topics[name])throw new Error('ADVISOR_FOUNDATION_MISSING:'+name);
    return '## Topic: '+name+'\n'+topics[name];
  }).join('\n\n');
}
export function advisorDiscoveryMap(topics:Readonly<Record<string,string>>):string {
  const catalog=Object.keys(topics).map(name=>{
    const related=new Set((ADVISOR_TOPIC_DEPENDENCIES[name]??[]).map(r=>r.topic));
    for(const match of topics[name].matchAll(/topic:\s*['"]([^'"]+)['"]/g))related.add(match[1]);
    const refs=[...related].filter(ref=>ref!==name&&Object.hasOwn(topics,ref));
    return name+': '+(ADVISOR_TOPIC_SUMMARIES[name]??'Read the complete contract.')+(refs.length?' Related: '+refs.join(', '):'');
  });
  return '# CAPABILITY AND DEPENDENCY DISCOVERY MAP\n'+catalog.join('\n')+'\n# CROSS-FEATURE POINTERS\n'
    +Object.entries(CROSS_FEATURE_POINTERS).map(([intent,refs])=>intent+' -> '+refs.filter(ref=>Object.hasOwn(topics,ref)).join(', ')).join('\n')
    +'\nPointers aid discovery, not proof of capabilities. Read complete relevant contracts before exact signatures; check adjacent authority, environment, retry and testing constraints. Omitted docs are unknown contracts, never missing project facts or needs_input. Preserve working authentication when diagnosing an existing session; do not add a replacement callback recipe unless its implementation is requested. Explain each decision once, without repeated component/prose summaries.';
}
export interface AdvisorDocsRead {
  text:string; included:string[]; omitted:Array<{topic:string;reason:'unavailable'|'complete_topic_budget'}>;
  bytes:number; remaining_bytes:number;
}
/** Try every requested whole contract independently: an oversized earlier topic
 * must not discard smaller later topics. Caller can request omissions in a later
 * authorized round; byte/output/cold-dollar budgets remain separate controls. */
export function readAdvisorDocs(requested:readonly string[],topics:Record<string,string>,tools:ToolDefinition[],maxBytes:number,caller:string):AdvisorDocsRead {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw new Error('ADVISOR_DOCS_BUDGET_INVALID');
  const included:string[]=[],omitted:AdvisorDocsRead['omitted']=[],blocks:string[]=[];
  let used=0;
  for(const topic of [...new Set(requested)]){
    if(!Object.hasOwn(topics,topic)){omitted.push({topic,reason:'unavailable'});continue;}
    const selected=selectAdvisorKnowledge(topic,topics,tools,{caller});
    const selectedTools=new Set(selected.selection.selected.filter(id=>id.startsWith('tool:')).map(id=>id.slice(5)));
    const schemas=tools.filter(tool=>selectedTools.has(tool.name)).map(tool=>'- '+tool.name+': '+tool.description.split('\n\n')[0]+'\nArguments: '+JSON.stringify(tool.inputSchema)).join('\n');
    const block='## Topic: '+topic+'\n'+topics[topic]+(schemas?'\n## Related caller tool contracts\n'+schemas:'');
    const size=bytes(block)+(blocks.length?2:0);
    if(used+size>maxBytes){omitted.push({topic,reason:'complete_topic_budget'});continue;}
    blocks.push(block);included.push(topic);used+=size;
  }
  // Metadata is outside the document-body packing budget and still counts in
  // the provider input/cost admission check. Bodies are never partially sliced.
  const metadata=JSON.stringify({included,omitted,contract_coverage_complete:omitted.length===0,omitted_contracts_are_unknown:true,not_missing_project_inputs:true});
  return {text:blocks.join('\n\n')+'\n## Retrieval coverage\n'+metadata,included,omitted,bytes:used,remaining_bytes:maxBytes-used};
}
