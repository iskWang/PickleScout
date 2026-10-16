// Container-only M1 integration check. Real npm, Cucumber, TypeScript and Chromium;
// Redis/SSE are stubbed, and a minimal test world isolates the existing template
// TS2322. This is not a complete LLM pipeline / generated-ZIP acceptance test.
// Run using the command in docs/reviews/2026-10-16-m1-bun.md.
const fs = require('fs/promises');
const path = require('path');
const assert = require('assert/strict');
const http = require('http');
const base = '/app/packages/backend/dist';
for (const [name, exports] of Object.entries({
  'redis.js': {updateJobStatus: async () => {}},
  'worker/sse.js': {emitEvent: async () => {}},
  'worker/generator.js': {buildOpenAIClient: () => {}, stripMarkdownJson: x => x},
})) require.cache[path.join(base, name)] = {id:path.join(base,name),filename:path.join(base,name),loaded:true,exports};
const {prepareVerificationDir} = require(base+'/worker/packager.js');
const {runVerifier} = require(base+'/worker/verifier.js');
async function browserProcesses() {
 const found=[];
 for (const pid of await fs.readdir('/proc')) {
  if (!/^\d+$/.test(pid)) continue;
  const cmd=await fs.readFile(`/proc/${pid}/cmdline`,'utf8').catch(()=>'');
  if (/chrome|chromium/.test(cmd)) found.push(Number(pid));
 }
 return found;
}
(async()=>{
 const dir=await fs.mkdtemp('/tmp/m1-real-smoke-');
 const server=http.createServer((req,res)=>res.end('<title>M1 browser smoke</title><h1>Bun migration</h1>'));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 try {
  await fs.mkdir(dir+'/features');await fs.mkdir(dir+'/steps');
  await prepareVerificationDir(dir);
  // Isolate the package-manager boundary from the existing world.ts template TS2322.
  if (process.env.M1_USE_GENERATED_WORLD !== '1') await fs.writeFile(dir+'/support/world.ts', `import {World,setWorldConstructor} from '@cucumber/cucumber';
import type {BrowserContext,Page} from '@playwright/test';
export class CustomWorld extends World { context!:BrowserContext; page!:Page; }
setWorldConstructor(CustomWorld);`);
  await fs.writeFile(dir+'/features/smoke.feature','Feature: M1\n  Scenario: Real browser\n    Given the local page is open\n    Then its title is correct\n');
  await fs.writeFile(dir+'/steps/steps.ts',`import {Given, Then} from '@cucumber/cucumber';
import {strict as assert} from 'assert';
import type {CustomWorld} from '../support/world';
Given('the local page is open', async function(this: CustomWorld) {await this.page.goto('${url}');});
Then('its title is correct', async function(this: CustomWorld) {assert.equal(await this.page.title(), 'M1 browser smoke');});`);
  const state={hash:'m1-real-smoke',options:{verificationMode:'smoke'}};
  const smoke=await runVerifier(state,dir);console.log('REAL_SMOKE',JSON.stringify(smoke));assert.equal(smoke.passed,true);
  const syntax=await runVerifier({...state,options:{verificationMode:'syntax-only'}},dir);console.log('REAL_SYNTAX',JSON.stringify(syntax));assert.equal(syntax.passed,true);
  await fs.writeFile(dir+'/features/smoke.feature','Feature: M1\n  Scenario: Abort browser\n    Given the browser waits\n');
  await fs.writeFile(dir+'/steps/steps.ts',`import {Given} from '@cucumber/cucumber';
import {writeFileSync} from 'fs';
import type {CustomWorld} from '../support/world';
Given('the browser waits', {timeout:60000}, async function(this:CustomWorld) {await this.page.goto('${url}');writeFileSync('ready',String(process.pid));await new Promise(resolve=>setTimeout(resolve,55000));});`);
  const controller=new AbortController();
  const aborted=runVerifier({...state,hash:'m1-real-abort'},dir,controller.signal).then(()=>{throw new Error('Abort unexpectedly resolved')},e=>{assert.equal(e.name,'AbortError')});
  for(let n=0;n<300;n++) {if(await fs.access(dir+'/ready').then(()=>true,()=>false))break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(await fs.access(dir+'/ready').then(()=>true,()=>false),true);
  const before=await browserProcesses();assert.ok(before.length>0);controller.abort();await aborted;
  for(let n=0;n<50 && (await browserProcesses()).length;n++)await new Promise(r=>setTimeout(r,100));
  const after=await browserProcesses();console.log('REAL_ABORT',JSON.stringify({browserProcessesBefore:before.length,browserProcessesAfter:after.length}));assert.equal(after.length,0);
 } finally {server.close();await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
