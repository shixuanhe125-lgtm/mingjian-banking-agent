import fs from 'node:fs/promises';
import {LocalAgent} from '../src/agent.mjs';
import {Bank} from '../src/bank.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const a=new LocalAgent(),b=new Bank(),s=b.createSession().id;
const cases=[
 {text:'先看看我手头还有多少，再给室友打两百块',tools:['balance','transfer'],amount:20000},
 {text:'帮我看看这个月的钱都花到哪里了，有没有重复扣费',tools:['bills']},
 {text:'我有哪些会员在扣钱？把视频那个停掉',tools:['subscriptions','cancel_subscription']},
 {text:'给妈妈转点钱',kind:'clarification'},
 {text:'就一千二百元吧',tools:['transfer'],amount:120000},
 {text:'先别转钱，我只是问一下你能做什么',kind:'chat'},
];
const results=[];
try{for(const c of cases){const r=await a.run(b,s,c.text);const tools=r.plan?.nodes.map(n=>n.tool);const passed=c.kind?r.kind===c.kind:JSON.stringify(tools)===JSON.stringify(c.tools)&&(!c.amount||r.plan.nodes.find(n=>n.tool==='transfer')?.args.amount===c.amount);results.push({input:c.text,expected:c,kind:r.kind,tools,passed,message:r.message,telemetry:r.telemetry});console.log(JSON.stringify(results.at(-1)));}}
finally{b.close();await fs.writeFile(path.join(path.dirname(fileURLToPath(import.meta.url)),'../test-results/live-model-results.json'),JSON.stringify(results,null,2));}
if(results.some(r=>!r.passed))process.exitCode=1;
