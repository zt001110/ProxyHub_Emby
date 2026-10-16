import assert from 'node:assert/strict';
import {waitProbeDns} from '../src/entry-probes.js';
const original=globalThis.fetch;const calls=[];
try{
 globalThis.fetch=async url=>{calls.push(url);return String(url).includes('cloudflare-dns.com')?Response.json({Status:3}):Response.json({Status:0,Answer:[{type:1,data:'172.64.79.192'}]});};
 const fallback=await waitProbeDns('rxp-test.rex-custom.invalid','172.64.79.192');assert(fallback.ready);assert.equal(fallback.source,'google');assert.equal(fallback.checks.length,2);assert.equal(calls.length,2);
 globalThis.fetch=async()=>{throw Error('timeout')};const timeout=await waitProbeDns('rxp-test.rex-custom.invalid','172.64.79.192');assert.equal(timeout.ready,false);assert.equal(timeout.reason,'resolver-timeout');assert.equal(timeout.checks.length,2);
 globalThis.fetch=async()=>Response.json({Status:3});const missing=await waitProbeDns('rxp-test.rex-custom.invalid','172.64.79.192');assert.equal(missing.ready,false);assert.equal(missing.reason,'nxdomain');
 globalThis.fetch=async()=>Response.json({Status:0,Answer:[{type:1,data:'172.64.79.1'}]});assert.equal((await waitProbeDns('rxp-test.rex-custom.invalid','172.64.79.192')).ready,false);
 console.log('PASS: bounded dual-resolver fallback, timeout/NXDOMAIN distinction, exact target IP matching; public DNS failure is never treated as proof of IP reachability.');
}finally{globalThis.fetch=original;}
