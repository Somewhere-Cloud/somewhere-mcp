/** Value-free top-level shapes. Operational errors remain in the caller response. */
export interface ToolSchemaShape {properties:Record<string,string[]>;required:string[];additionalProperties?:boolean;version?:string}
export type ArgumentType='string'|'number'|'integer'|'boolean'|'object'|'array'|'null';
export interface FailureShape {version:1;source:'advertised_schema';schema_version:string;tool:string;failure_class:'missing_required'|'wrong_type'|'unknown_fields'|'runtime_rejection';known_args:Array<{key:string;type:ArgumentType}>;missing_required:string[];type_mismatches:Array<{key:string;expected:string[];actual:ArgumentType}>;unknown_key_count:number;additional_properties_allowed:boolean;nested_value_count:number}
const TYPES:readonly string[]=['string','number','integer','boolean','object','array','null'];
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
function typeOf(value:unknown):ArgumentType {return value===null?'null':Array.isArray(value)?'array':typeof value==='number'?(Number.isInteger(value)?'integer':'number'):typeof value==='boolean'?'boolean':typeof value==='string'?'string':'object';}
function compile(tool:string,schema:ToolSchemaShape,known:FailureShape['known_args'],unknown:number,nested:number):FailureShape {
  const missing=schema.required.filter(key=>Object.hasOwn(schema.properties,key)&&!known.some(arg=>arg.key===key));
  const mismatch=known.filter(arg=>{const types=schema.properties[arg.key];return types.length>0&&!types.includes(arg.type)&&!(arg.type==='integer'&&types.includes('number'));}).map(arg=>({key:arg.key,expected:schema.properties[arg.key],actual:arg.type}));
  return {version:1,source:'advertised_schema',schema_version:schema.version??'live',tool,failure_class:missing.length?'missing_required':mismatch.length?'wrong_type':unknown&&schema.additionalProperties===false?'unknown_fields':'runtime_rejection',known_args:known,missing_required:missing,type_mismatches:mismatch,unknown_key_count:unknown,additional_properties_allowed:schema.additionalProperties!==false,nested_value_count:nested};
}
export function describeMcpFailure(tool:string,schema:ToolSchemaShape,args:Record<string,unknown>):FailureShape {
  const known:FailureShape['known_args']=[];let unknown=0,nested=0;
  for(const key of Object.keys(schema.properties).slice(0,64)){if(Object.hasOwn(args,key)){const value=args[key];known.push({key,type:typeOf(value)});if(value!==null&&typeof value==='object')nested++;}}
  unknown=Math.min(64,Object.keys(args).filter(key=>!Object.hasOwn(schema.properties,key)).length);
  return compile(tool,schema,known,unknown,nested);
}
/** Reject arbitrary strings/keys before telemetry storage and any correction-model input. */
export function parseMcpFailure(value:unknown,tool:string,schema:ToolSchemaShape):FailureShape|null {
  const input=record(value);if(input&&Object.keys(input).some(key=>!['version','source','schema_version','tool','failure_class','known_args','missing_required','type_mismatches','unknown_key_count','additional_properties_allowed','nested_value_count'].includes(key)))return null;if(!input||input.version!==1||input.source!=='advertised_schema'||input.schema_version!==schema.version||input.tool!==tool||!Array.isArray(input.known_args)||input.known_args.length>64)return null;
  const known:FailureShape['known_args']=[];
  for(const raw of input.known_args){const arg=record(raw);if(!arg||Object.keys(arg).some(key=>!['key','type'].includes(key))||typeof arg.key!=='string'||!Object.hasOwn(schema.properties,arg.key)||typeof arg.type!=='string'||!TYPES.includes(arg.type)||known.some(v=>v.key===arg.key))return null;known.push({key:arg.key,type:arg.type as ArgumentType});}
  const count=(name:string):number|null=>typeof input[name]==='number'&&Number.isSafeInteger(input[name])&&Number(input[name])>=0&&Number(input[name])<=64?Number(input[name]):null;
  const unknown=count('unknown_key_count'),nested=count('nested_value_count');if(unknown===null||nested===null)return null;
  const safe=compile(tool,schema,known,unknown,nested);if(input.additional_properties_allowed!==safe.additional_properties_allowed||input.failure_class!==safe.failure_class||JSON.stringify(input.missing_required)!==JSON.stringify(safe.missing_required)||JSON.stringify(input.type_mismatches)!==JSON.stringify(safe.type_mismatches))return null;return safe;
}
export function schemaCorrection(shape:FailureShape):string|null {
  const fixes=[...shape.missing_required.map(key=>'Supply '+key+' ('+(shape.type_mismatches.find(v=>v.key===key)?.expected.join(' or ')||'required field')+').'),...shape.type_mismatches.map(v=>'Use '+v.key+' as '+v.expected.join(' or ')+', not '+v.actual+'.')];
  if(shape.unknown_key_count&&!shape.additional_properties_allowed)fixes.push('Remove unsupported argument fields; read this tool’s current advertised schema.');
  return fixes.length?fixes.join(' '):null;
}
