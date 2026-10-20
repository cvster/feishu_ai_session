import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZcodeClient, zcodeProviderEnv } from '../../../src/agent/zcode/client';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function bundle(){
 const root=await mkdtemp(join(tmpdir(),'zcode-layout-'));roots.push(root);
 const entry=join(root,'resources/glm/zcode.cjs');const provider=join(root,'resources/config/provider/zcode-builtin.json');
 await mkdir(join(root,'resources/glm'),{recursive:true});await mkdir(join(root,'resources/config/provider'),{recursive:true});
 await writeFile(entry,'');await writeFile(provider,'{}');
 return {root,entry,provider,command:{binary:process.execPath,args:[entry]}};
}
it('finds the desktop provider asset relative to the real CLI entry and preserves explicit configuration',async()=>{
 const h=await bundle();
 expect(zcodeProviderEnv(h.command,{})).toEqual({ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:h.provider});
 expect(zcodeProviderEnv(h.command,{ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:'/custom/provider.json'})).toEqual({});
 const link=join(h.root,'zcode.cjs');await symlink(h.entry,link);
 expect(zcodeProviderEnv({binary:process.execPath,args:[link]},{})).toEqual({ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:h.provider});
});
it('preserves standalone package lookup and leaves unrelated wrappers or missing assets alone',async()=>{
 const h=await bundle();const standalone=join(h.root,'resources/glm/provider/zcode-builtin.json');
 await mkdir(join(h.root,'resources/glm/provider'),{recursive:true});await writeFile(standalone,'{}');
 expect(zcodeProviderEnv(h.command,{})).toEqual({ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:standalone});
 expect(zcodeProviderEnv({binary:'zcode',args:[]},{})).toEqual({});
 await rm(standalone);await rm(h.provider);
 expect(zcodeProviderEnv(h.command,{})).toEqual({});
});
it('starts metadata discovery with the bundled provider without sending any model input',async()=>{
 const h=await bundle();
 await writeFile(h.entry,`
 if(!process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE)process.exit(1);
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);if(r.method!=='session/list')process.exit(2);
  process.stdout.write(JSON.stringify({id:r.id,result:{sessions:[{sessionId:'session_new',title:'AA-test-zcode',sessionKind:'interactive'}]}})+'\\n');
 });`);
 const client=new ZcodeClient({binary:process.execPath,args:[h.entry]});
 try{expect((await client.request('session/list',{limit:10000})).sessions[0]).toMatchObject({sessionId:'session_new',title:'AA-test-zcode'});}
 finally{await client.close();}
});
