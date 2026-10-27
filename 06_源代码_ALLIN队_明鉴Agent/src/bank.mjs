import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { CONTACTS, SUBSCRIPTIONS, TOOLS, parseIntent, validateDag } from './planner.mjs';
import {newSecret,matchTotp} from './totp.mjs';

export class BankError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const hash = s => createHash('sha256').update(s).digest('hex');
const date = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export class Bank {
  constructor(path = ':memory:', options = {}) {
    this.db = new DatabaseSync(path);
    this.now = options.now || (() => Date.now());
    this.day = options.day || date;
    this.requireAuthenticator=!!options.requireAuthenticator;
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS account(id TEXT PRIMARY KEY, balance INTEGER NOT NULL CHECK(balance>=0));
      CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, csrf TEXT NOT NULL, context TEXT NOT NULL DEFAULT '{}', failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, session TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transfers(id TEXT PRIMARY KEY, plan TEXT NOT NULL, node TEXT NOT NULL, recipient TEXT NOT NULL, amount INTEGER NOT NULL, day TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(plan,node));
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, session TEXT NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL, previous TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges(plan TEXT NOT NULL, node TEXT NOT NULL, version INTEGER NOT NULL, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(plan,node));
      CREATE TABLE IF NOT EXISTS expenses(id TEXT PRIMARY KEY, merchant TEXT NOT NULL, category TEXT NOT NULL, amount INTEGER NOT NULL, occurred TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(plan TEXT NOT NULL,node TEXT NOT NULL,version INTEGER NOT NULL,token_hash TEXT NOT NULL,context_hash TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(plan,node));
      CREATE TABLE IF NOT EXISTS revisions(plan TEXT NOT NULL,version INTEGER NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(plan,version));
      CREATE TABLE IF NOT EXISTS authenticator(id TEXT PRIMARY KEY,secret TEXT NOT NULL,last_step INTEGER NOT NULL DEFAULT -1);
      CREATE TABLE IF NOT EXISTS enrollments(session TEXT PRIMARY KEY,secret TEXT NOT NULL,expires INTEGER NOT NULL);
    `);
    this.db.prepare("INSERT OR IGNORE INTO account VALUES ('main',2500000)").run();
    for (const s of SUBSCRIPTIONS) this.db.prepare('INSERT OR IGNORE INTO subscriptions VALUES (?,1)').run(s.id);
    if(!this.db.prepare("SELECT value FROM metadata WHERE key='expenses_seeded'").get()) {
      const month=this.day().slice(0,7);
      const seed=[['房屋租赁','房租',180000,'02T09:00:00'],['校园食堂','餐饮',8600,'03T12:00:00'],['城市地铁','交通',1600,'04T08:00:00'],['社区超市','购物',10000,'05T18:00:00'],['音乐会员','订阅',1800,'06T09:00:00'],['视频会员','订阅',2500,'07T09:00:00'],['云盘会员','订阅',1200,'08T09:00:00'],['城市地铁','交通',3000,'09T08:00:00'],['社区餐馆','餐饮',10000,'10T19:00:00'],['模拟云商店','购物',9900,'12T10:00:00'],['模拟云商店','购物',9900,'12T10:01:00'],['校园食堂','餐饮',10000,'15T12:00:00']];
      this.atomic(()=>{for(const [merchant,category,amount,when] of seed)this.db.prepare('INSERT INTO expenses VALUES(?,?,?,?,?)').run(randomUUID(),merchant,category,amount,`${month}-${when}+08:00`);this.db.prepare("INSERT INTO metadata VALUES('expenses_seeded','1')").run();});
    }
  }
  close() { this.db.close(); }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  log(session, event, data = {}) {
    const previous = this.db.prepare('SELECT digest FROM audit ORDER BY seq DESC LIMIT 1').get()?.digest || 'GENESIS';
    const at = this.now(), payload = JSON.stringify(data);
    const digest = hash(JSON.stringify([at, session, event, payload, previous]));
    this.db.prepare('INSERT INTO audit(at,session,event,payload,previous,digest) VALUES(?,?,?,?,?,?)').run(at, session, event, payload, previous, digest);
  }
  session(id) { return id && this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id); }
  createSession() {
    const id = randomUUID(), csrf = randomUUID();
    this.db.prepare('INSERT INTO sessions(id,csrf) VALUES(?,?)').run(id, csrf);
    return this.session(id);
  }
  guard(session) {
    const s = this.session(session);
    if (!s) throw new BankError('会话无效',401);
    if (!this.verifyAudit()) throw new BankError('审计链校验失败，已停止业务操作，请由本机管理员检查数据。',423);
    if (s.locked_until > this.now()) throw new BankError('安全锁定中，请等待5分钟后重试，或由本机管理员在关闭程序后重置演示数据。',423);
    return s;
  }
  failure(session, event) {
    const s = this.session(session);
    const failures = s.failures + 1, until = failures >= 3 ? this.now() + 300000 : 0;
    this.db.prepare('UPDATE sessions SET failures=?,locked_until=? WHERE id=?').run(failures,until,session);
    this.log(session,event,{ failures, lockedUntil: until });
  }
  balance() { return this.db.prepare("SELECT balance FROM account WHERE id='main'").get().balance; }
  securityStatus(){return {required:this.requireAuthenticator,enrolled:!!this.db.prepare("SELECT id FROM authenticator WHERE id='main'").get()};}
  enrollBegin(session){
    this.guard(session);
    if(this.securityStatus().enrolled)throw new BankError('验证器已绑定，当前版本不允许通过聊天或网页重置',409);
    const secret=newSecret(),expires=this.now()+600000;
    this.db.prepare('INSERT OR REPLACE INTO enrollments VALUES(?,?,?)').run(session,secret,expires);
    return {secret,expires,uri:`otpauth://totp/Mingjian:local-account?secret=${secret}&issuer=Mingjian&digits=6&period=30`,message:'在手机验证器中添加基于时间的账号，手动输入密钥，随后提交6位动态码完成绑定。此密钥不要分享。'};
  }
  enrollConfirm(session,code){
    this.guard(session);
    if(this.securityStatus().enrolled)throw new BankError('已经绑定验证器',409);
    const e=this.db.prepare('SELECT * FROM enrollments WHERE session=?').get(session);
    const step=e&&e.expires>this.now()?matchTotp(e.secret,code,this.now()):null;
    if(step===null){this.failure(session,'verification_failed');throw new BankError('动态码无效，请检查手机时间；未完成绑定',403);}
    this.atomic(()=>{this.db.prepare("INSERT INTO authenticator VALUES('main',?,?)").run(e.secret,step);this.db.prepare('DELETE FROM enrollments').run();this.log(session,'authenticator_enrolled',{method:'totp',secretStored:'local_database_not_encrypted'});});
    return this.securityStatus();
  }
  daily() { return this.db.prepare('SELECT COALESCE(SUM(amount),0) AS amount FROM transfers WHERE day=?').get(this.day()).amount; }
  policy(node, cumulative = this.daily()) {
    if (['balance','bills'].includes(node.tool)) return { level:'green', reason:'纯查询，不改变账户与合约', projectedDaily:cumulative };
    if (node.tool === 'transfer') {
      const projectedDaily = cumulative + node.args.amount;
      return { level: projectedDaily > 100000 ? 'red':'yellow', reason: projectedDaily > 100000 ? `本笔计入后今日累计转账超过1000元，须${this.requireAuthenticator?'手机验证器动态码':'模拟强验证'}`:'本笔计入后今日累计转账不超过1000元，须明确确认', projectedDaily };
    }
    return { level:'yellow', reason: node.tool === 'subscriptions' ? '按赛题要求，订阅查询也需确认':'取消代扣合约须明确确认', projectedDaily:cumulative };
  }
  validateNode(node) {
    if (!TOOLS[node.tool]) throw new BankError('工具不在白名单');
    if (node.tool === 'transfer' && (!CONTACTS.some(c=>c.id===node.args.recipient) || !Number.isSafeInteger(node.args.amount) || node.args.amount<=0 || node.args.amount>100000000)) throw new BankError('收款人或金额无效，单笔模拟上限100万元');
    if (node.tool === 'cancel_subscription' && !SUBSCRIPTIONS.some(s=>s.id===node.args.subscription)) throw new BankError('订阅不存在');
  }
  makePlan(session, text, candidate = null) {
    const s = this.guard(session);
    const parsed = candidate || parseIntent(text,JSON.parse(s.context));
    if (parsed.kind !== 'plan') {
      if (parsed.kind === 'rejected') this.failure(session,'instruction_rejected');
      else this.log(session,'clarification_requested',{ message:parsed.message });
      return parsed;
    }
    parsed.nodes.forEach(n=>this.validateNode(n));
    return this.atomic(()=>{
      const id=randomUUID(), created=this.now();
      const nodes=parsed.nodes.map(n=>({...n,status:'pending',result:null}));
      validateDag(nodes);
      this.db.prepare('INSERT INTO plans VALUES(?,?,1,?,?,?,?)').run(id,session,'active',JSON.stringify(nodes),created,created+900000);
      this.db.prepare('UPDATE sessions SET context=? WHERE id=?').run(JSON.stringify({...JSON.parse(s.context),...parsed.context}),session);
      this.log(session,'plan_created',{ plan:id,version:1,nodes:parsed.nodes });
      this.auto(session,id);
      return {kind:'plan',plan:this.getPlan(session,id)};
    });
  }
  rawPlan(session,id) {
    const p=this.db.prepare('SELECT * FROM plans WHERE id=? AND session=?').get(id,session);
    if(!p) throw new BankError('任务不存在',404);
    p.nodes=JSON.parse(p.body); return p;
  }
  save(p) { this.db.prepare('UPDATE plans SET version=?,status=?,body=? WHERE id=?').run(p.version,p.status,JSON.stringify(p.nodes),p.id); }
  ensureActive(p) {
    if(p.expires<=this.now()) throw new BankError('计划已过期，请重新描述需求',409);
    if(p.status!=='active') throw new BankError('计划当前为'+p.status+'，不能执行',409);
  }
  ready(p) { return p.nodes.find(n=>n.status==='pending' && n.dependsOn.every(id=>p.nodes.find(x=>x.id===id)?.status==='completed')); }
  auto(session,id) {
    const p=this.rawPlan(session,id);
    for(let n=this.ready(p); n && this.policy(n).level==='green'; n=this.ready(p)) this.executeTool(session,p,n);
    if(p.nodes.every(n=>n.status==='completed')) p.status='completed';
    this.save(p);
  }
  getPlan(session,id) {
    const p=this.rawPlan(session,id);
    let cumulative=this.daily(), balance=this.balance();
    const nodes=p.nodes.map(n=>{
      const policy=n.status==='completed' && n.executedPolicy ? n.executedPolicy : this.policy(n,cumulative), before=balance;
      if(n.status==='pending' && n.tool==='transfer') { cumulative=policy.projectedDaily; balance-=n.args.amount; }
      return {...n,title:TOOLS[n.tool],policy,impact:{before,after:balance,fee:0},recipient:CONTACTS.find(c=>c.id===n.args.recipient),subscription:SUBSCRIPTIONS.find(s=>s.id===n.args.subscription)};
    });
    const revision=this.db.prepare('SELECT evidence FROM revisions WHERE plan=? ORDER BY version DESC LIMIT 1').get(id);
    return {id:p.id,version:p.version,status:p.status,created:p.created,expires:p.expires,nodes,next:this.ready(p)?.id || null,lastChange:revision?JSON.parse(revision.evidence):null};
  }
  reviewContext(p,n) {
    return {plan:p.id,node:n.id,version:p.version,args:n.args,balance:this.balance(),daily:this.daily(),day:this.day()};
  }
  review(session,id,nodeId,version) {
    this.guard(session);
    const p=this.rawPlan(session,id);this.ensureActive(p);
    if(p.version!==version)throw new BankError('计划版本已变化，请重新审阅',409);
    const n=this.ready(p);
    if(!n||n.id!==nodeId)throw new BankError('请按任务依赖顺序操作',409);
    const token=randomUUID(),expires=this.now()+120000,context=this.reviewContext(p,n);
    const terms={...context,policy:this.policy(n),after:context.balance-(n.tool==='transfer'?n.args.amount:0),fee:0,currency:'CNY'};
    this.db.prepare('INSERT OR REPLACE INTO reviews VALUES(?,?,?,?,?,?)').run(id,nodeId,version,hash(token),hash(JSON.stringify(context)),expires);
    return {token,expires,terms};
  }
  executeTool(session,p,n) {
    this.validateNode(n);
    n.executedPolicy=this.policy(n);
    let result;
    if(n.tool==='balance') result={balance:this.balance(),unit:'CNY',source:'本地模拟账本'};
    if(n.tool==='bills') {
      const month=this.day().slice(0,7);
      const records=this.db.prepare('SELECT * FROM expenses WHERE occurred LIKE ? ORDER BY occurred').all(month+'%');
      const sums=new Map(),alerts=[];
      for(let i=0;i<records.length;i++){
        const r=records[i];sums.set(r.category,(sums.get(r.category)||0)+r.amount);
        const previous=records.slice(0,i).find(x=>x.merchant===r.merchant && x.amount===r.amount && Math.abs(Date.parse(r.occurred)-Date.parse(x.occurred))<=120000);
        if(previous)alerts.push({merchant:r.merchant,amount:r.amount,records:[previous.id,r.id],reason:'同商户同金额在2分钟内重复出现，需人工核实；不直接认定为欺诈'});
      }
      result={month,total:records.reduce((v,r)=>v+r.amount,0),categories:[...sums].map(([name,amount])=>({name,amount})).sort((a,b)=>b.amount-a.amount),alerts,records,source:'从本地合成交易明细实时聚合；含疑似重复交易，转账另列'};
    }
    if(n.tool==='subscriptions') result={subscriptions:SUBSCRIPTIONS.map(s=>({...s,active:!!this.db.prepare('SELECT active FROM subscriptions WHERE id=?').get(s.id).active})),source:'本地模拟订阅表'};
    if(n.tool==='cancel_subscription') {
      const changed=this.db.prepare('UPDATE subscriptions SET active=0 WHERE id=? AND active=1').run(n.args.subscription).changes;
      result={cancelled:!!changed,alreadyCancelled:!changed,subscription:n.args.subscription,effective:'模拟未来续费已关闭；不退回历史扣款'};
    }
    if(n.tool==='transfer') {
      if(this.balance()<n.args.amount) throw new BankError('余额不足，交易未执行',409);
      const id=randomUUID();
      this.db.prepare("UPDATE account SET balance=balance-? WHERE id='main'").run(n.args.amount);
      this.db.prepare('INSERT INTO transfers VALUES(?,?,?,?,?,?,?)').run(id,p.id,n.id,n.args.recipient,n.args.amount,this.day(),this.now());
      result={receipt:id,amount:n.args.amount,recipient:n.args.recipient,balance:this.balance(),status:'settled',source:'本地模拟交易账本'};
    }
    n.status='completed'; n.result=result;
    this.log(session,'tool_executed',{plan:p.id,node:n.id,tool:n.tool,result});
  }
  challenge(session,id,nodeId,version) {
    this.guard(session);
    const p=this.rawPlan(session,id); this.ensureActive(p);
    if(p.version!==version) throw new BankError('计划版本已变化',409);
    const n=this.ready(p);
    if(!n || n.id!==nodeId || this.policy(n).level!=='red') throw new BankError('当前节点无需或不能发起强验证');
    if(this.requireAuthenticator){if(!this.securityStatus().enrolled)throw new BankError('请先在安全设置中绑定手机验证器。不会生成同机演示码。',428);return {method:'totp',message:'请输入手机验证器的6位动态码，同一时间窗口的码不能重复授权。'};}
    const code=String(randomInt(100000,1000000));
    this.db.prepare('INSERT OR REPLACE INTO challenges VALUES(?,?,?,?,?)').run(id,nodeId,version,hash(code),this.now()+120000);
    this.log(session,'demo_challenge_issued',{plan:id,node:nodeId,version});
    return {demoCode:code,expires:this.now()+120000,warning:'仅用于本地演示的验证码，显示在同一设备上，不是生产级第二因素'};
  }
  confirm(session,id,nodeId,body) {
    this.guard(session);
    const pre=this.rawPlan(session,id), prior=pre.nodes.find(n=>n.id===nodeId);
    if(pre.version!==body.version) throw new BankError('授权版本已失效，请重新审阅',409);
    if(prior?.status==='completed') return {plan:this.getPlan(session,id),replayed:true};
    this.ensureActive(pre);
    const n=this.ready(pre);
    if(!n || n.id!==nodeId) throw new BankError('请按任务依赖顺序操作',409);
    if(body.confirmed!==true) throw new BankError('需要明确确认');
    const review=this.db.prepare('SELECT * FROM reviews WHERE plan=? AND node=?').get(id,nodeId);
    if(!review || review.version!==pre.version || review.expires<=this.now() || review.token_hash!==hash(String(body.reviewToken||'')))
      throw new BankError('审阅凭证缺失或已失效，请重新打开审阅窗口',409);
    if(review.context_hash!==hash(JSON.stringify(this.reviewContext(pre,n))))
      throw new BankError('余额、日累计或日期已变化，资金影响需要重新审阅',409);
    const policy=this.policy(n);
    let acceptedTotpStep=null;
    if(policy.level==='red') {
      if(this.requireAuthenticator){
        const a=this.db.prepare("SELECT * FROM authenticator WHERE id='main'").get();
        if(!a)throw new BankError('红色操作需先绑定手机验证器',428);
        acceptedTotpStep=matchTotp(a.secret,body.code,this.now(),a.last_step);
        if(acceptedTotpStep===null){this.failure(session,'verification_failed');throw new BankError('动态码无效、已使用或时间不一致；交易未执行',403);}
      }else{
      const c=this.db.prepare('SELECT * FROM challenges WHERE plan=? AND node=?').get(id,nodeId);
      const supplied=hash(String(body.code||''));
      if(!c || c.version!==pre.version || c.expires<=this.now() || !timingSafeEqual(Buffer.from(c.code_hash),Buffer.from(supplied))) {
        this.failure(session,'verification_failed'); throw new BankError('验证码无效或已过期；交易未执行',403);
      }
      }
    }
    return this.atomic(()=>{
      const p=this.rawPlan(session,id); this.ensureActive(p);
      const current=this.ready(p);
      if(!current || current.id!==nodeId || p.version!==body.version) throw new BankError('计划发生变化',409);
      this.log(session,'operation_authorized',{plan:id,node:nodeId,version:p.version,contextHash:review.context_hash,policy:this.policy(current),method:policy.level==='red'?(this.requireAuthenticator?'totp_and_confirmation':'demo_code_and_confirmation'):'explicit_confirmation'});
      this.executeTool(session,p,current); this.save(p);
      if(acceptedTotpStep!==null)this.db.prepare("UPDATE authenticator SET last_step=? WHERE id='main'").run(acceptedTotpStep);
      this.db.prepare('DELETE FROM challenges WHERE plan=? AND node=?').run(id,nodeId);
      this.db.prepare('DELETE FROM reviews WHERE plan=? AND node=?').run(id,nodeId);
      this.db.prepare('UPDATE sessions SET failures=0 WHERE id=?').run(session);
      this.auto(session,id);
      return {plan:this.getPlan(session,id),replayed:false};
    });
  }
  edit(session,id,nodeId,{version,amount,recipient}) {
    this.guard(session);
    return this.atomic(()=>{
      const p=this.rawPlan(session,id); this.ensureActive(p);
      if(p.version!==version) throw new BankError('计划版本已变化',409);
      const n=p.nodes.find(n=>n.id===nodeId);
      if(!n || n.status!=='pending' || n.tool!=='transfer') throw new BankError('只能修改尚未执行的转账');
      const before=this.getPlan(session,id);
      n.args={amount,recipient}; this.validateNode(n); validateDag(p.nodes);
      p.version++; this.save(p);
      this.db.prepare('DELETE FROM challenges WHERE plan=?').run(id);
      this.db.prepare('DELETE FROM reviews WHERE plan=?').run(id);
      const after=this.getPlan(session,id);
      const compare=x=>({args:x.args,recipient:x.recipient?.name,level:x.policy.level,projectedDaily:x.policy.projectedDaily,balanceBefore:x.impact.before,balanceAfter:x.impact.after});
      const changes=after.nodes.filter(x=>x.status==='pending'&&x.tool==='transfer').map(x=>({node:x.id,before:compare(before.nodes.find(b=>b.id===x.id)),after:compare(x)})).filter(x=>JSON.stringify(x.before)!==JSON.stringify(x.after));
      const evidence={plan:id,node:nodeId,fromVersion:before.version,toVersion:p.version,at:this.now(),changes,invalidated:'旧版本确认、审阅凭证及验证码全部失效'};
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?)').run(id,p.version,JSON.stringify(evidence));
      this.log(session,'plan_modified',evidence);
      return this.getPlan(session,id);
    });
  }
  control(session,id,action,version) {
    this.guard(session);
    if(!['pause','resume','cancel','handoff'].includes(action)) throw new BankError('未知控制动作');
    return this.atomic(()=>{
      const p=this.rawPlan(session,id);
      if(p.version!==version) throw new BankError('计划版本已变化',409);
      if(p.expires<=this.now() || ['completed','cancelled','handoff'].includes(p.status)) throw new BankError('当前计划不能更改',409);
      if(action==='resume' && p.status!=='paused') throw new BankError('计划没有暂停');
      p.status={pause:'paused',resume:'active',cancel:'cancelled',handoff:'handoff'}[action]; p.version++;
      this.save(p); this.db.prepare('DELETE FROM challenges WHERE plan=?').run(id);
      this.db.prepare('DELETE FROM reviews WHERE plan=?').run(id);
      this.log(session,'plan_'+action,{plan:id,version:p.version,note:action==='handoff'?'已生成本地人工处理工单，未连接真实客服':undefined});
      if(action==='resume') this.auto(session,id);
      return this.getPlan(session,id);
    });
  }
  audit(session) {
    return this.db.prepare('SELECT * FROM audit WHERE session=? ORDER BY seq DESC LIMIT 120').all(session).map(r=>({...r,payload:JSON.parse(r.payload)}));
  }
  verifyAudit() {
    let previous='GENESIS';
    for(const r of this.db.prepare('SELECT * FROM audit ORDER BY seq').all()) {
      if(r.previous!==previous || r.digest!==hash(JSON.stringify([r.at,r.session,r.event,r.payload,r.previous]))) return false;
      previous=r.digest;
    }
    return true;
  }
  snapshot(session) {
    const s=this.session(session);
    return {balance:this.balance(),daily:this.daily(),contacts:CONTACTS,history:JSON.parse(s.context).turns||[],plans:this.db.prepare('SELECT id FROM plans WHERE session=? ORDER BY created DESC LIMIT 20').all(session).map(p=>this.getPlan(session,p.id)),audit:this.audit(session),auditValid:this.verifyAudit(),lockedUntil:s.locked_until,security:this.securityStatus(),mode:'bank_sandbox',disclaimer:'本地银行业务沙箱，账户和资金均为模拟数据；模型状态以引擎接口为准'};
  }
}
