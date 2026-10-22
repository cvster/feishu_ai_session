const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WebSocketServer } = require('ws');
const home = process.env.DSH_HOME;
fs.mkdirSync(home, {recursive:true});
const file = path.join(home,'fixture.json');
const load = () => JSON.parse(fs.readFileSync(file,'utf8'));
const save = data => fs.writeFileSync(file,JSON.stringify(data));
if (process.argv.includes('--version')) { console.log('0.2.0-rc.2'); process.exit(0); }
const feeds = new Map();
function add(row,type,data) { const event={type,seq:row.events.length,time:Date.now(),data};row.events.push({type:'event',event});return {type:'event',event}; }
const snapshot = row => ({type:'snapshot',header:{id:row.id,cwd:row.cwd,createdAt:row.created},cursor:row.events.length-1,records:row.events,hasMore:false,
  projections:{asOfSeq:row.events.length-1,values:{title:row.title,permissions:{currentValue:row.permission},modelSelection:{next:row.model},userQuestions:{active:[]}}}});
const server=http.createServer(async(req,res)=>{
  if(req.method==='GET' && req.url.startsWith('/?token=')){res.writeHead(303,{'set-cookie':'dsh-test=correct; HttpOnly','location':'/'});res.end();return;}
  if(req.headers.cookie!=='dsh-test=correct'){res.writeHead(403);res.end();return;}
  let raw='';for await(const chunk of req) raw+=chunk;
  const message=JSON.parse(raw);const method=message.method;const args=message.payload.args;const request=args.request;
  const state=load();state.requests??=[];state.sessions??={};state.archived??=[];state.requests.push({method,args});
  let value;
  try {
    if(method==='session/modelCatalog') value={default:{provider:'tars',model:'model/one'},routableProviders:['tars','second'],groups:[{id:'tars',name:'same name',models:[{id:'model/one',name:'one',reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'low'}}]},{id:'second',name:'same name',models:[{id:'model/one',name:'one'}]}],failures:[{message:'CREDENTIAL_SECRET'}]};
    else if(method==='session/list') value={items:Object.values(state.sessions).map(row=>({sessionId:row.id,cwd:row.cwd,updatedAt:row.created,running:row.running,projections:{values:{title:row.title,modelSelection:{next:row.model}}}}))};
    else if(method==='session/create') {const id=request.sessionId||'session-'+randomUUID();state.sessions[id]??={id,cwd:request.cwd,created:Date.now(),events:[],running:false,permission:'workspace-write'};value={sessionId:id};}
    else if(method==='session/rename'){state.sessions[request.sessionId].title=request.title;value={title:request.title};}
    else if(method==='session/selectModel'){state.sessions[request.sessionId].model={provider:request.provider,model:request.model,reasoningEffort:request.reasoningEffort};value={selected:state.sessions[request.sessionId].model};}
    else if(method==='commands/execute'){state.sessions[args.agentId].permission=args.line.split(' ')[1];value={result:{kind:'success'}};}
    else if(method==='session/projections'){value=snapshot(state.sessions[request.sessionId]).projections;}
    else if(method==='workspace/archiveSession'){state.archived.push(request.sessionId);value={archivedSessionIds:state.archived};}
    else if(method==='session/fork'){const source=state.sessions[request.sessionId];const id='session-'+randomUUID();state.sessions[id]={...source,id,running:false,events:[...source.events]};value={sessionId:id};}
    else if(method==='session/cancel'){state.sessions[request.sessionId].running=false;value={accepted:true};}
    else if(method==='session/prompt') {
      const row=state.sessions[request.sessionId];row.running=true;value={accepted:true};
      const emit=value=>{for(const feed of feeds.get(row.id)||[])feed.socket.send(JSON.stringify({type:'item',streamId:feed.id,value}));};
      save(state);
      if(state.mode==='disconnect'){for(const feed of feeds.get(row.id)||[])feed.socket.close();res.destroy();return;}
      if(state.mode==='lost-ack'){res.writeHead(500);res.end('CREDENTIAL_SECRET');return;}
      if(state.mode==='wait'){res.end(JSON.stringify({type:'server-response',rpcId:message.rpcId,result:{ok:true,value}}));return;}
      setTimeout(()=>{
        const updated=load(),r=updated.sessions[row.id];
        emit(add(r,'agent/inbox/spliced',{inserted:[{source:{rpcId:request.requestId}}]}));
        emit(add(r,'user/message',{id:'user-'+request.requestId,role:'user',source:{kind:'user',rpcId:request.requestId},content:request.content}));
        if(updated.mode==='model-error'){emit(add(r,'turn/end',{reason:{kind:'error',error:{code:'MISSING_CREDENTIAL'}}}));r.running=false;save(updated);return;}
        const attempt='attempt-test';emit({type:'assistant-stream',frame:{type:'start',attemptId:attempt}});
        const chunk={type:'assistant-stream',frame:{type:'chunk',attemptId:attempt,index:0,chunk:{type:'text-delta',text:'reply'}}};emit(chunk);emit(chunk);
        emit(add(r,'assistant/message',{message:{content:[{type:'text',text:'reply'}]},usage:{inputTokens:4,outputTokens:1}}));
        emit(add(r,'tool/call',{callId:'tool-test',name:'read',arguments:'{"path":"marker.txt"}'}));
        emit(add(r,'tool/result',{message:{toolCallId:'tool-test',content:[{type:'text',text:'marker'}],isError:false}}));
        emit(add(r,'turn/end',{reason:{kind:'completed'}}));r.running=false;save(updated);
      },25);
      res.end(JSON.stringify({type:'server-response',rpcId:message.rpcId,result:{ok:true,value}}));return;
    } else throw Error('unknown');
    save(state);res.end(JSON.stringify({type:'server-response',rpcId:message.rpcId,result:{ok:true,value}}));
  }catch{save(state);res.end(JSON.stringify({type:'server-response',rpcId:message.rpcId,result:{ok:false,error:{code:'fixture/refused',message:'CREDENTIAL_SECRET'}}}));}
});
const sockets=new WebSocketServer({server});
sockets.on('connection',socket=>socket.on('message',raw=>{
  const frame=JSON.parse(raw);if(frame.type!=='open')return;const state=load();
  if(frame.endpoint==='workspace/follow'){socket.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{type:'baseline',value:{archivedSessionIds:state.archived||[]}}}));return;}
  const id=frame.payload.args.request.address.sessionId,row=state.sessions[id];
  if(!row){socket.send(JSON.stringify({type:'error',streamId:frame.streamId,error:{code:'session/missing'}}));return;}
  const feed={socket,id:frame.streamId};const rows=feeds.get(id)||[];rows.push(feed);feeds.set(id,rows);
  socket.on('close',()=>feeds.set(id,(feeds.get(id)||[]).filter(f=>f!==feed)));
  socket.send(JSON.stringify({type:'item',streamId:'unrelated-stream',value:{type:'event',event:{seq:100,data:{text:'FOREIGN'}}}}));
  socket.send(JSON.stringify({type:'item',streamId:frame.streamId,value:snapshot(row)}));
}));
server.listen(0,'127.0.0.1',()=>console.log(`dsh web: http://127.0.0.1:${server.address().port}/?token=test-private-token`));
