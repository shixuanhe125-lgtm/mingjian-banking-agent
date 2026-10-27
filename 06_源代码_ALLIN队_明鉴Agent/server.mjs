import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { Bank, BankError } from './src/bank.mjs';
import {LocalAgent} from './src/agent.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const allowedFiles={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
export function createServer(bank,{agent=null}={}) {
  const rates=new Map();
  return http.createServer(async(req,res)=>{
    const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host=req.headers.host || '';
      if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new BankError('仅允许本机访问',403);
      const url=new URL(req.url,'http://'+host);
      if(!url.pathname.startsWith('/api/')) {
        if(req.method!=='GET' || !allowedFiles[url.pathname]) throw new BankError('页面不存在',404);
        const file=allowedFiles[url.pathname];
        res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
        res.end(await readFile(path.join(root,'public',file))); return;
      }
      let sid=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('bank_session='))?.slice(13);
      let session=bank.session(sid);
      if(req.method==='GET' && url.pathname==='/api/session') {
        if(!session) {session=bank.createSession();res.setHeader('Set-Cookie',`bank_session=${session.id}; HttpOnly; SameSite=Strict; Path=/`);}
        return json(200,{csrf:session.csrf,...bank.snapshot(session.id)});
      }
      if(!session) throw new BankError('请刷新页面建立会话',401);
      sid=session.id;
      if(req.method==='GET' && url.pathname==='/api/state') return json(200,bank.snapshot(sid));
      if(req.method==='GET' && url.pathname==='/api/engine')return json(200,agent?await agent.status():{mode:'offline_rules',ready:true,message:'规则测试模式，不是真实模型'});
      if(req.method!=='POST') throw new BankError('请求方式不支持',405);
      if(req.headers.origin!==`http://${host}` || req.headers['x-csrf-token']!==session.csrf) throw new BankError('来源或防伪令牌无效',403);
      if(!String(req.headers['content-type']).startsWith('application/json')) throw new BankError('请求须为JSON',415);
      const rate=rates.get(sid)||{start:Date.now(),count:0};
      if(Date.now()-rate.start>60000){rate.start=Date.now();rate.count=0;}
      rate.count++; rates.set(sid,rate);
      if(rate.count>90) throw new BankError('请求过于频繁，请稍后重试',429);
      let raw='';
      for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>10000) throw new BankError('请求过大',413);}
      let body;try{body=JSON.parse(raw);}catch{throw new BankError('JSON格式错误');}
      if(!body || typeof body!=='object' || Array.isArray(body)) throw new BankError('请求体无效');
      if(url.pathname==='/api/security/enroll')return json(200,bank.enrollBegin(sid));
      if(url.pathname==='/api/security/verify')return json(200,bank.enrollConfirm(sid,body.code));
      if(url.pathname==='/api/plan') return json(200,agent?await agent.run(bank,sid,body.text):bank.makePlan(sid,body.text));
      const m=url.pathname.match(/^\/api\/plans\/([\w-]+)\/(review|confirm|challenge|edit|control)$/);
      if(!m) throw new BankError('接口不存在',404);
      const [,id,action]=m;
      if(action==='review')return json(200,bank.review(sid,id,body.node,body.version));
      if(action==='confirm') return json(200,bank.confirm(sid,id,body.node,body));
      if(action==='challenge') return json(200,bank.challenge(sid,id,body.node,body.version));
      if(action==='edit') return json(200,{plan:bank.edit(sid,id,body.node,body)});
      if(action==='control') return json(200,{plan:bank.control(sid,id,body.action,body.version)});
    } catch(e) {
      if(!(e instanceof BankError)) console.error('服务错误：',e.message);
      json(e instanceof BankError?e.status:500,{error:e instanceof BankError?e.message:'服务暂时无法执行，未返回成功结果。请检查本机日志。'});
    }
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  await mkdir(path.join(root,'data'),{recursive:true});
  const port=Number(process.env.PORT||8787);
  const bank=new Bank(path.join(root,'data','bank.sqlite'),{requireAuthenticator:process.env.BANK_AGENT_MODE!=='rules'});
  const agent=process.env.BANK_AGENT_MODE==='rules'?null:new LocalAgent();
  const server=createServer(bank,{agent});
  server.listen(port,'127.0.0.1',()=>console.log(`明鉴银行助手 http://127.0.0.1:${port}\n${agent?'真实本地模型模式':'规则测试模式'} · 模拟账户 · Ctrl+C停止`));
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>{bank.close();process.exit(0);}));
}
