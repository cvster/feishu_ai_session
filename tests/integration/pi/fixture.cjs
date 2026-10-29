const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
if (process.argv.includes('--version')) { console.log('1.4.0'); process.exit(0); }
const args = process.argv.slice(2), root = process.env.PI_CODING_AGENT_DIR;
const value = flag => args[args.indexOf(flag) + 1];
const mode = args.find(a => a.startsWith('--fixture-mode='))?.split('=')[1];
const requests = path.join(root, 'requests.jsonl'); fs.mkdirSync(root, { recursive: true });
let sessionFile = args.includes('--session') ? value('--session') : path.join(root, 'sessions', '--fixture--', `${args.includes('--session-id') ? value('--session-id') : randomUUID()}.jsonl`);
let entries = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
let header = entries.shift() || { type: 'session', version: 3, id: path.basename(sessionFile, '.jsonl'), cwd: process.cwd(), timestamp: new Date().toISOString() };
let model = { provider: 'tars', id: 'model/one', name: 'One', reasoning: true };
if (args.includes('--model') && !value('--model').startsWith('missing/')) { const ref = value('--model'), i = ref.indexOf('/'); model = { provider: ref.slice(0, i), id: ref.slice(i + 1), reasoning: true }; }
let thinkingLevel = args.includes('--thinking') ? value('--thinking') : 'high';
let name = args.includes('--name') ? value('--name') : [...entries].reverse().find(e => e.type === 'session_info')?.name;
const emit = e => process.stdout.write(JSON.stringify(e) + '\n');
const persist = () => { fs.mkdirSync(path.dirname(sessionFile), { recursive: true }); fs.writeFileSync(sessionFile, [header, ...entries].map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 }); };
const append = entry => { const e = { id: randomUUID(), parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), ...entry }; entries.push(e); persist(); return e; };
let buffer = '';
process.stdin.setEncoding('utf8');process.stdin.on('data', chunk => { buffer += chunk; let i; while ((i=buffer.indexOf('\n'))>=0) {const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line)handle(JSON.parse(line));}});
function handle(c) {
  fs.appendFileSync(requests, JSON.stringify({ ...c, argv: args }) + '\n');
  const reply = data => emit({ type: 'response', command: c.type, id: c.id, success: true, data });
  if (c.type === 'get_state') {
    if (mode === 'malformed') { process.stdout.write('not json\n'); return; }
    return reply({ sessionId: header.id, sessionFile, sessionName: name, model, thinkingLevel, isStreaming: false, isCompacting: false });
  }
  if (c.type === 'get_available_models') return reply({ models: [model, { provider:'other',id:'model/one',name:'Other',reasoning:false }] });
  if (c.type === 'set_model') { model = { provider: c.provider, id: c.modelId, reasoning: c.provider === 'tars' }; return reply(model); }
  if (c.type === 'get_available_thinking_levels') return reply({levels:model.reasoning ? ['off','low','high'] : ['off']});
  if (c.type === 'set_session_name') { name=c.name; append({ type:'session_info',name }); return reply(); }
  if (c.type === 'clone') { header={...header,id:randomUUID(),parentSession:sessionFile};sessionFile=path.join(path.dirname(sessionFile),header.id+'.jsonl');persist();return reply({cancelled:false}); }
  if (c.type === 'get_entries') return reply({ entries, leafId:entries.at(-1)?.id??null });
  if (c.type === 'abort') { reply();emit({type:'agent_settled',aborted:true});return; }
  if (c.type === 'prompt') {
    append({type:'model_change',provider:model.provider,modelId:model.id});append({type:'thinking_level_change',thinkingLevel});
    if(name)append({type:'session_info',name});
    append({type:'message',message:{role:'user',content:c.message,timestamp:Date.now()}});
    if(mode==='disconnect'){process.stderr.write('CREDENTIAL_SECRET');process.exit(1);}
    reply({disposition:'started'});if(mode==='wait')return;
    emit({type:'message_start',message:{role:'assistant'}});
    const text='reply\u2028中文\u2029';
    emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}});
    emit({type:'tool_execution_start',toolCallId:'tool',toolName:'read',args:{path:'README.md'}});
    emit({type:'tool_execution_end',toolCallId:'tool',toolName:'read',result:{content:[{type:'text',text:'file'}]},isError:false});
    const message={role:'assistant',content:[{type:'text',text}],model:model.id,provider:model.provider,stopReason:mode==='model-error'?'error':'stop',errorMessage:'CREDENTIAL_SECRET',usage:{input:2,output:3,cost:{total:0}}};
    append({type:'message',message});emit({type:'message_end',message});emit({type:'agent_end',messages:[message]});
    setTimeout(()=>emit({type:'agent_settled',aborted:false}),30);return;
  }
  emit({type:'response',command:c.type,id:c.id,success:false,error:'CREDENTIAL_SECRET'});
}
