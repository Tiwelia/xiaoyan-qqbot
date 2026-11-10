import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmClient } from '../src/llm.js';
import { createBot } from '../src/bot.js';
import { handleMessage } from '../src/conversation.js';
import { createSerialQueue, runWithDeadline } from '../src/queue.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { MemoryStore } from '../src/memory.js';
import { SessionStore } from '../src/session.js';
import { createToolkit } from '../src/tools.js';
import { chunkText } from '../src/text.js';

const logger={info(){},warn(){},error(){},debug(){}};
const config=()=>loadConfig({QQBOT_APPID:'test',QQBOT_SECRET:'placeholder',DEEPSEEK_API_KEY:'placeholder',OWNER_OPENID:'test',STREAMING:'false',TYPING_INDICATOR:'false'});
const msg={kind:'c2c',senderId:'test',messageId:'test',content:'hello',replyTarget:{scope:'c2c',targetId:'test',msgId:'test'}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const client=()=>new LlmClient({baseUrl:'https://invalid.example',apiKey:'placeholder',model:'test',timeoutMs:500,logger});
const event=value=>'data: '+JSON.stringify(value)+'\r\n\r\n';
const choice=(delta={},finish_reason=null)=>({choices:[{delta,finish_reason}]});
function mockSse(t,text,{fragment=false}={}) {
    const bytes=new TextEncoder().encode(text);
    t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(controller){
        if(fragment)for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));
        else controller.enqueue(bytes);
        controller.close();
    }}),{headers:{'content-type':'text/event-stream'}}));
}
function deps(overrides={}) {
    const delivered=[],history=[];
    return {config:config(),logger,
        bot:{sendTyping:async()=>{},sendText:async(_target,text)=>delivered.push(text)},
        llm:{stream:async()=>({text:'reply',toolCalls:[]})},
        memory:{renderForPrompt:()=>'',available:false},
        sessions:{toMessages:()=>[],append:(_s,_t,entries)=>history.push(entries)},
        toolkit:{definitions:[],execute:async()=> 'ok'}, delivered,history,...overrides};
}
function temporary(t){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyan-regression-'));
    t.after(()=>{const rel=path.relative(path.resolve(os.tmpdir()),path.resolve(root));assert.ok(rel.startsWith('xiaoyan-regression-')&&!rel.includes(path.sep));fs.rmSync(root,{recursive:true,force:true});});
    return root;
}

test('real message wiring supplies its QQ instance to the pipeline',async()=>{
    class Bot {
        handlers={};delivered=[];
        use(){} on(event,handler){this.handlers[event]=handler;}
        async sendTyping(){} async sendText(_target,text){this.delivered.push(text);}
    }
    const d=deps(); delete d.bot;
    const bot=createBot(d,{Bot});
    await bot.handlers.message({state:{}},msg);
    assert.deepEqual(bot.delivered,['reply']);assert.equal(d.history.length,1);
    await bot.drain();
});

test('deadline retains serialization until old work actually exits',async()=>{
    const enqueue=createSerialQueue(),order=[];
    const first=enqueue('same',()=>runWithDeadline(async signal=>{
        await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
        await sleep(10);order.push('old-cleanup');signal.throwIfAborted();
    },5));
    const second=enqueue('same',async()=>order.push('next-start'));
    await assert.rejects(first,/超时/);await second;
    assert.deepEqual(order,['old-cleanup','next-start']);
});

test('aborted turn cannot send late reply or persist completed history',async()=>{
    const controller=new AbortController();
    const d=deps({llm:{stream:async({signal})=>{assert.equal(signal,controller.signal);controller.abort(new Error('test abort'));return {text:'late',toolCalls:[]};}}});
    await assert.rejects(handleMessage(d,{state:{}},msg,{signal:controller.signal}),/test abort/);
    assert.deepEqual(d.delivered,[]);assert.deepEqual(d.history,[]);
});

test('shutdown aborts active work and skips queued messages',async()=>{
    class Bot {
        handlers={};use(){} on(event,handler){this.handlers[event]=handler;}
        async sendTyping(){} async sendText(){throw Error('unexpected delivery');}
    }
    let ready;const started=new Promise(r=>{ready=r;});let calls=0;
    const d=deps({llm:{stream:({signal})=>new Promise((_,reject)=>{
        calls++;ready();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    })}});delete d.bot;
    const bot=createBot(d,{Bot});const first=bot.handlers.message({state:{}},msg);
    await started;const second=bot.handlers.message({state:{}},msg);
    await bot.drain();await Promise.all([first,second]);assert.equal(calls,1);assert.deepEqual(d.history,[]);
});

test('SSE handles byte-split Chinese, CRLF and usage',async t=>{
    mockSse(t,event(choice({content:'你好'}))+event(choice({},'stop'))+event({usage:{total_tokens:3},choices:[]})+'data: [DONE]\r\n\r\n',{fragment:true});
    const result=await client().stream({messages:[]});assert.equal(result.text,'你好');assert.equal(result.usage.total_tokens,3);
});

test('SSE flushes the last event without a trailing newline',async t=>{
    mockSse(t,'data: '+JSON.stringify(choice({content:'complete'},'stop')));
    assert.equal((await client().stream({messages:[]})).text,'complete');
});

for(const tail of ['', 'data: [DONE]\n\n'])test(`SSE rejects unfinished output ${tail?'with DONE':'at EOF'}`,async t=>{
    mockSse(t,event(choice({content:'partial'}))+tail);
    await assert.rejects(client().stream({messages:[]}),/未完成/);
});

// 撞到长度上限但已经有正文：交出去，别让整轮作废（长代码/patch 很常见）
test('SSE keeps partial text when finish_reason=length',async t=>{
    mockSse(t,event(choice({content:'partial'},'length')));
    const r=await client().stream({messages:[]});
    assert.equal(r.text,'partial'); assert.equal(r.truncated,true);
});
test('SSE rejects finish_reason=content_filter',async t=>{
    mockSse(t,event(choice({content:'partial'},'content_filter')));
    await assert.rejects(client().stream({messages:[]}),/未完成/);
});

test('SSE rejects malformed JSON and stream-level errors',async t=>{
    mockSse(t,'data: {broken}\n\n');await assert.rejects(client().stream({messages:[]}),/无法解析/);
    t.mock.restoreAll();mockSse(t,event({error:{message:'upstream problem'}}));await assert.rejects(client().stream({messages:[]}),/流内错误/);
});

test('SSE accumulates fragmented tool names and arguments',async t=>{
    mockSse(t,event(choice({tool_calls:[{index:0,id:'call-1',function:{name:'rem',arguments:'{"kind":'}}]}))+
        event(choice({tool_calls:[{index:0,function:{name:'ember',arguments:'"rule","content":"test"}'}}]},'tool_calls')));
    const r=await client().stream({messages:[]});assert.equal(r.toolCalls[0].name,'remember');assert.equal(JSON.parse(r.toolCalls[0].args).content,'test');
});

test('already-aborted model call never performs fetch',async t=>{
    const fetch=t.mock.method(globalThis,'fetch',()=>{throw Error('unexpected fetch');});
    await assert.rejects(client().stream({messages:[],signal:AbortSignal.abort(new Error('already stopped'))}),/already stopped/);
    assert.equal(fetch.mock.callCount(),0);
});

test('final allowed tool round executes and is followed by a tools-disabled answer',async()=>{
    let calls=0,writes=0;
    const d=deps();d.config.llm.maxToolRounds=1;
    d.toolkit={definitions:[{type:'function',function:{name:'remember'}}],execute:async()=>{writes++;return 'saved';}};
    d.llm={stream:async opts=>{
        calls++;
        if(calls===1){assert.equal(opts.tools.length,1);return {text:'intermediate',toolCalls:[{id:'1',name:'remember',args:'{}'}]};}
        assert.equal(opts.tools,undefined);assert.equal(opts.messages.at(-1).role,'tool');return {text:'final',toolCalls:[]};
    }};
    await handleMessage(d,{state:{}},msg);assert.equal(writes,1);assert.deepEqual(d.delivered,['final']);
});

test('image download stops at byte limit instead of buffering entire response',async t=>{
    let pulls=0,cancelled=false;
    t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}},{highWaterMark:0}),{headers:{'content-type':'image/png'}}));
    const d=deps();d.config.llm.visionModel='vision';
    await handleMessage(d,{state:{}},{...msg,attachments:[{content_type:'image/png',url:'https://invalid.example/test.png'}]});
    assert.equal(cancelled,true);assert.ok(pulls<=5);assert.deepEqual(d.delivered,['reply']);
});

test('identical remember calls reuse one fact and disabled tools cannot write',async t=>{
    const memory=new MemoryStore({dbPath:path.join(temporary(t),'memory.db'),logger});memory.init();
    try {
        const first=memory.addImportant('rule','same fact');assert.equal(memory.addImportant('rule','same fact'),first);assert.equal(memory.count().important,1);
        const tool=createToolkit({memory,logger,enabled:false});await tool.execute({name:'remember',args:'{"content":"must not write"}'});assert.equal(memory.count().important,1);
    } finally {memory.close();}
});

test('failed memory initialization closes its connection',t=>{
    const root=temporary(t),file=path.join(root,'not-a-db');fs.writeFileSync(file,'not sqlite');
    const memory=new MemoryStore({dbPath:file,logger});assert.equal(memory.init(),false);assert.equal(memory.available,false);assert.equal(memory.db,null);
});

test('invalid numeric configuration is rejected before startup',()=>{
    const c=config();c.behavior.textChunkLimit=0;c.behavior.maxConcurrency=-1;
    assert.ok(validateConfig(c).some(x=>x.includes('TEXT_CHUNK_LIMIT')));
    assert.ok(validateConfig(c).some(x=>x.includes('MAX_CONCURRENCY')));
    assert.throws(()=>chunkText('hello',0),/正整数/);
});

test('malformed numeric env values fail validation instead of silently changing meaning',()=>{
    for(const value of ['123oops','1.5','NaN']) {
        const c=loadConfig({LLM_MAX_TOKENS:value});
        assert.ok(validateConfig(c).some(x=>x.includes('LLM_MAX_TOKENS')));
    }
    assert.ok(validateConfig(loadConfig({LLM_TEMPERATURE:'1oops'})).some(x=>x.includes('LLM_TEMPERATURE')));
    assert.ok(validateConfig(loadConfig({LLM_THINKING:'wrong'})).some(x=>x.includes('LLM_THINKING')));
});

test('thinking setting is sent explicitly only when configured',async t=>{
    const bodies=[];
    t.mock.method(globalThis,'fetch',async(_url,opts)=>{
        bodies.push(JSON.parse(opts.body));
        return new Response(event(choice({content:'ok'},'stop')));
    });
    for(const thinking of ['auto','enabled','disabled']) {
        const c=client();c.provider='deepseek';c.thinking=thinking;
        await c.stream({messages:[]});
    }
    assert.equal(Object.hasOwn(bodies[0],'thinking'),false);
    assert.deepEqual(bodies[1].thinking,{type:'enabled'});
    assert.deepEqual(bodies[2].thinking,{type:'disabled'});
});

test('long replies stay inside the passive quota instead of losing the tail',async()=>{
    const body='甲乙丙丁。'.repeat(5); // 25 字：单块 10 字时一定会超块数，但总额度装得下
    for(const [kind,limit] of [['c2c',3],['group',5]]) {
        const d=deps(),sent=[];
        d.config.behavior.textChunkLimit=10;
        d.llm.stream=async()=>({text:body,toolCalls:[]});
        d.bot.sendText=async(target,text)=>sent.push({target,text});
        await handleMessage(d,{state:{}},{...msg,kind});
        assert.ok(sent.length<=limit, `${kind} 应当不超过 ${limit} 块，实际 ${sent.length}`);
        assert.ok(sent.every(x=>x.text.length<=10), '每块都不能超过单条上限');
        assert.ok(sent.every(x=>x.target.msgId==='test'), '全部保持被动回复关联');
        assert.equal(sent.map(x=>x.text).join('').replace(/\s/g,''),body.replace(/\s/g,''), '内容不许丢');
    }
});

test('text beyond the quota budget is truncated with a marker',async()=>{
    const d=deps(),sent=[];
    d.config.behavior.textChunkLimit=10;
    d.llm.stream=async()=>({text:'长'.repeat(500),toolCalls:[]});
    d.bot.sendText=async(target,text)=>sent.push(text);
    await handleMessage(d,{state:{}},{...msg,kind:'c2c'});
    assert.ok(sent.length<=4, `单聊被动额度 4，实际 ${sent.length}`);
    assert.ok(sent.join('').endsWith('…'), '截断处要留记号');
});

test('history trimming and reload never leave orphaned assistant replies or exceed byte budget',t=>{
    const dir=temporary(t),sessions=new SessionStore({dir,historyLimit:3,historyBytes:50,logger});
    sessions.append('c2c','test',[{role:'user',content:'one'},{role:'assistant',content:'answer1'},{role:'user',content:'two'},{role:'assistant',content:'answer2'}]);
    assert.deepEqual(sessions.toMessages('c2c','test').map(x=>x.content),['two','answer2']);
    sessions.flushAll();
    const restored=new SessionStore({dir,historyLimit:3,historyBytes:5,logger});
    assert.deepEqual(restored.toMessages('c2c','test'),[]);
    sessions.append('c2c','large',[{role:'user',content:'x'.repeat(100)},{role:'assistant',content:'y'.repeat(100)}]);
    assert.deepEqual(sessions.toMessages('c2c','large'),[]);sessions.flushAll();
});


