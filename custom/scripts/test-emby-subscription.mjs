import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {serveEmbySubscription,parseList,policies,decodeEmbyTrojanHeader,decodeEmbyTrojanRequest,latencyProbeResponse} from '../subscription/core.js';
import {createHash} from 'node:crypto';
const worker={fetch:serveEmbySubscription};
let stored;const env={ADMIN_TOKEN:'fixture-admin',SUB_TOKEN:'a'.repeat(48),TROJAN_PASSWORD:'b'.repeat(48),u:'fixture-uuid',CF_DOMAIN:'panel.example.invalid',DB:{prepare(sql){return {bind(...args){return {async first(){return stored?{value:stored}:null},async run(){stored=args[1];return {success:true}}}}}}}};
env.TUNNEL_DOMAIN='subscription.example.invalid';env.EMBY_SUB_TOKEN=env.SUB_TOKEN;env.EMBY_TROJAN_PASSWORD=env.TROJAN_PASSWORD;
const admin=(body,token=env.ADMIN_TOKEN)=>new Request('https://service/admin',{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token},...(body?{body:JSON.stringify(body)}:{})});
assert.equal((await worker.fetch(admin(null,'bad'),env)).status,401);
assert.equal((await worker.fetch(new Request('https://service/__emby-sub/'+env.SUB_TOKEN+'/surge.list'),env)).status,503);
for(const list of ['127.0.0.1:443','10.1.1.1:443','172.16.1.1:443','100.64.0.1:443','https://1.1.1.1','1.1.1.1:80','1.1.1.1:443#x\nInjected','1.1.1.999:443'])assert.throws(()=>parseList(list));
let config=await (await worker.fetch(admin({list:'108.162.198.1:443\n154.83.2.231:2087',mode:'matched'}),env)).json();assert.equal(config.nodes.length,2);const id=config.nodes[0].id;
config=await (await worker.fetch(admin({list:'108.162.198.1:443\n154.83.2.231:2087',mode:'matched'}),env)).json();assert.equal(config.nodes[0].id,id);
const sub=await worker.fetch(new Request(config.subscriptionUrl),env);const body=await sub.text();assert(body.includes(', 2087,'));assert(body.includes('ws=true'));assert(body.includes('sni=subscription.example.invalid'));assert(body.includes('ws-headers=Host:subscription.example.invalid'));assert(body.includes('test-url=http://subscription.example.invalid/__emby-sub/latency'));assert(!body.includes('test-url=https://'));assert(!body.includes('[General]')&&!body.includes('FINAL,'));assert(!body.includes(env.ADMIN_TOKEN));assert.equal(sub.headers.get('cache-control'),'no-store');assert.equal(new URL(config.subscriptionUrl).pathname,'/'+env.SUB_TOKEN);const legacy=await worker.fetch(new Request('https://service/__emby-sub/'+env.SUB_TOKEN+'/surge.list'),env);assert.equal(legacy.status,200);assert.equal(await legacy.text(),body);
assert.equal((await worker.fetch(new Request(config.subscriptionUrl.replace(env.SUB_TOKEN,'wrong')),env)).status,404);
const hash=createHash('sha224').update(env.TROJAN_PASSWORD).digest('hex');
function header(target,port=443){const h=Buffer.from(target);return Buffer.concat([Buffer.from(hash+'\r\n'),Buffer.from([1,3,h.length]),h,Buffer.from([port>>8,port&255,13,10]),Buffer.from('payload')]);}
assert.equal(Buffer.from(decodeEmbyTrojanHeader(header(env.CF_DOMAIN),hash,env.CF_DOMAIN)).toString(),'payload');
assert.equal(decodeEmbyTrojanHeader(header(env.CF_DOMAIN).subarray(0,30),hash,env.CF_DOMAIN),null);
for(const [target,port] of [['example.com',443],['127.0.0.1',443],[env.CF_DOMAIN,80]])assert.throws(()=>decodeEmbyTrojanHeader(header(target,port),hash,env.CF_DOMAIN));
assert.throws(()=>decodeEmbyTrojanHeader(header(env.CF_DOMAIN),'0'.repeat(56),env.CF_DOMAIN));
const probe=decodeEmbyTrojanRequest(header(env.TUNNEL_DOMAIN,80),hash,env.CF_DOMAIN,env.TUNNEL_DOMAIN);assert(probe.probe);assert.throws(()=>decodeEmbyTrojanRequest(header('example.com',80),hash,env.CF_DOMAIN,env.TUNNEL_DOMAIN));assert.throws(()=>decodeEmbyTrojanRequest(header(env.TUNNEL_DOMAIN,443),hash,env.CF_DOMAIN,env.TUNNEL_DOMAIN));
const request=(path='/__emby-sub/latency',method='HEAD',host=env.TUNNEL_DOMAIN)=>Buffer.from(method+' '+path+' HTTP/1.1\r\nHost: '+host+'\r\n\r\n');
assert.equal(latencyProbeResponse(request().subarray(0,10),env.TUNNEL_DOMAIN),null);assert.match(new TextDecoder().decode(latencyProbeResponse(request(),env.TUNNEL_DOMAIN)),/^HTTP\/1.1 204/);
for(const args of [['/'],['/__emby-sub/latency','CONNECT'],['/__emby-sub/latency','HEAD','example.com']])assert.throws(()=>latencyProbeResponse(request(...args),env.TUNNEL_DOMAIN));assert.throws(()=>latencyProbeResponse(Buffer.alloc(4097),env.TUNNEL_DOMAIN));
// Exercise the WebSocket path: latency probes must never dial a relay or origin.
const RealResponse=globalThis.Response,RealPair=globalThis.WebSocketPair;let fakeServer,connections=0;
globalThis.Response=class extends RealResponse{constructor(body,options){if(options?.status===101)return {status:101,webSocket:options.webSocket};super(body,options)}};
globalThis.WebSocketPair=class{constructor(){this[0]={};this[1]=fakeServer={handlers:{},sent:[],accept(){},close(){},addEventListener(name,fn){this.handlers[name]=fn},send(bytes){this.sent.push(bytes)}}}};
try{env.EMBY_TROJAN_HASH=hash;env.SOCKET_CONNECT=()=>{connections++;throw Error('Probe must not connect')};const ws=await worker.fetch(new Request('https://service/__emby-sub/ws/'+id,{headers:{Upgrade:'websocket'}}),env);assert.equal(ws.status,101);const auth=header(env.TUNNEL_DOMAIN,80).subarray(0,-7),http=request();const first=Buffer.concat([auth,http.subarray(0,10)]);fakeServer.handlers.message({data:first.buffer.slice(first.byteOffset,first.byteOffset+first.byteLength)});await new Promise(resolve=>setImmediate(resolve));assert.equal(fakeServer.sent.length,0);const rest=http.subarray(10);fakeServer.handlers.message({data:rest.buffer.slice(rest.byteOffset,rest.byteOffset+rest.byteLength)});await new Promise(resolve=>setImmediate(resolve));assert.equal(connections,0);assert.equal(fakeServer.sent.length,1);assert.match(new TextDecoder().decode(fakeServer.sent[0]),/^HTTP\/1.1 204/);
}finally{globalThis.Response=RealResponse;if(RealPair)globalThis.WebSocketPair=RealPair;else delete globalThis.WebSocketPair;}
stored=undefined;env.yx='1.1.1.1:443,1.0.0.1:8443';env.p='8.8.8.8:443';
const initial=await (await worker.fetch(admin(),env)).json();assert.equal(initial.source,'environment');assert.equal(initial.nodes.length,2);assert.equal(initial.p,'8.8.8.8:443');
const again=await (await worker.fetch(admin(),env)).json();assert.equal(again.nodes[0].id,initial.nodes[0].id);
await worker.fetch(admin({list:'9.9.9.9:443',mode:'matched'}),env);env.yx='invalid';const override=await (await worker.fetch(admin(),env)).json();assert.equal(override.source,'panel');assert.equal(override.nodes[0].host,'9.9.9.9');
assert.equal((await worker.fetch(admin({useEnvironment:true}),env)).status,400);assert(stored);
env.yx='1.1.1.1:443,1.0.0.1:8443';const fallback=await (await worker.fetch(admin({useEnvironment:true}),env)).json();assert.equal(fallback.source,'environment');assert.equal(fallback.nodes[0].id,initial.nodes[0].id);assert.equal(fallback.integration.clientStatus,'unknown');assert(!stored);
console.log('PASS: subscription auth, stable node IDs, TLS ports, IPv4 validation, no full profile/global rules, token isolation, fixed server-selected relay, Emby-only destination/443, authenticated bounded latency probe with no outbound socket, fragmented probe headers and no fallback.');
