import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { ClaudeNativeConversationReader } from '../../../src/agent/claude/conversation';
it('reads the existing Claude model and project effort without leaking settings or changing history',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'claude-reasoning-'));
  try {
    const config=join(dir,'config'),cwd=join(dir,'project'),id='11111111-2222-3333-4444-555555555555';
    await mkdir(join(config,'projects','project'),{recursive:true});await mkdir(join(cwd,'.claude'),{recursive:true});
    await writeFile(join(config,'settings.json'),JSON.stringify({model:'other',env:{SECRET:'PRIVATE_KEY'},modelSettings:{native:{effortLevel:'low'}}}));
    await writeFile(join(cwd,'.claude','settings.local.json'),JSON.stringify({modelSettings:{native:{effortLevel:'max'}}}));
    const history=join(config,'projects','project',id+'.jsonl');
    const rows=[{sessionId:id,uuid:'u',type:'user',cwd,timestamp:'2026-10-24T00:00:00Z',message:{content:'input'}},
      {sessionId:id,uuid:'a',type:'assistant',cwd,message:{model:'native',content:[{type:'text',text:'answer'}],stop_reason:'end_turn'}}];
    await writeFile(history,rows.map(r=>JSON.stringify(r)).join('\n'));
    const reader=new ClaudeNativeConversationReader(config);
    const snapshot=await reader.read(id);
    expect(snapshot.settings).toEqual({model:'native',reasoningEffort:'max'});
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_KEY'); await reader.close();
  } finally { await rm(dir,{recursive:true,force:true}); }
});
