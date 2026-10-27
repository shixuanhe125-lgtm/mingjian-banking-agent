const $=s=>document.querySelector(s);
const money=v=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'}).format(v/100);
const time=v=>new Date(v).toLocaleString('zh-CN',{hour12:false});
let state, csrf, selected, auth, editing, busy=false;
async function engineStatus(){
  try{const e=await api('/api/engine');$('#engine-status').textContent=e.mode==='local_llm'?`${e.model} · ${e.ready?'本地推理已就绪':'尚未就绪'}`:'规则测试模式';$('#engine-pill').textContent=e.mode==='local_llm'?(e.ready?'真实本地模型':'模型未启动'):'规则测试';$('#engine-note').textContent=e.mode==='local_llm'?(e.ready?'真实模型在本机理解和规划，结果由银行工具返回。无需API密钥。':e.message):'当前为规则测试模式，不是真实模型。请使用产品启动器进入模型模式。';}catch{$('#engine-status').textContent='模型状态读取失败';}
}
function h(tag,attrs={},...children){
  const el=document.createElement(tag);
  for(const [k,v]of Object.entries(attrs)){
    if(k.startsWith('on')) el.addEventListener(k.slice(2),v);
    else if(k==='class')el.className=v;
    else if(k==='disabled')el.disabled=v;
    else el.setAttribute(k,v);
  }
  for(const c of children.flat()) if(c!==null&&c!==undefined) el.append(c instanceof Node?c:document.createTextNode(String(c)));
  return el;
}
async function api(url,data){
  const r=await fetch(url,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(data)});
  const b=await r.json();if(!r.ok)throw new Error(b.error||'请求失败');return b;
}
function notify(message=''){ $('#banner').textContent=message; }
function message(text,role='assistant'){
  $('#messages').append(h('div',{class:`message ${role}`},h('span',{class:'message-label'},role==='user'?'你':'明鉴'),h('p',{},text)));
  $('#messages').scrollTop=$('#messages').scrollHeight;
}
async function refresh(initial=false){
  state=await api(initial?'/api/session':'/api/state');
  if(initial)csrf=state.csrf;
  if(initial&&state.history)for(const turn of state.history)message(turn.content,turn.role==='user'?'user':'assistant');
  render();
}
const statuses={active:'等待下一步授权',completed:'全部完成',paused:'已暂停',cancelled:'未执行步骤已取消',handoff:'已转本地人工工单'};
const levelNames={green:'绿色 · 自动',yellow:'黄色 · 确认',red:'红色 · 强验证'};
function current(){return state.plans.find(p=>p.id===selected);}
function render(){
  $('#balance').textContent=money(state.balance);$('#daily').textContent=money(state.daily);
  $('#security-status').textContent=state.security?.enrolled?'已绑定':state.security?.required?'尚未绑定':'规则测试模式';
  $('#begin-enroll').disabled=!!state.security?.enrolled;
  const select=$('#plan-select');select.replaceChildren();
  for(const p of state.plans)select.append(h('option',{value:p.id},`${p.nodes.map(n=>n.title).join(' → ')} · v${p.version}`));
  if(!state.plans.length)select.append(h('option',{value:''},'尚无任务'));
  if(!state.plans.some(p=>p.id===selected))selected=state.plans[0]?.id;
  select.value=selected||'';
  if(current())renderPlan(current());
  if(state.lockedUntil>Date.now())notify(`安全锁定至 ${time(state.lockedUntil)}。账本可查看，操作已暂停。`);
  $('#audit-status').textContent=state.auditValid?'✓ 全部审计记录哈希链校验通过':'⚠ 审计链校验失败，请停止操作并检查数据';
  $('#audit-status').className=state.auditValid?'green':'red';
  const labels={plan_created:'创建任务计划',tool_executed:'工具执行与回执',operation_authorized:'用户授权',demo_challenge_issued:'发起模拟强验证',verification_failed:'验证失败',plan_modified:'修改计划并作废旧授权',plan_pause:'暂停计划',plan_resume:'恢复计划',plan_cancel:'取消未执行步骤',plan_handoff:'生成人工处理工单',instruction_rejected:'拒绝越权指令',clarification_requested:'请求补充信息'};
  $('#audit-list').replaceChildren(...state.audit.map(a=>h('article',{class:'audit-row'},h('time',{},time(a.at)),h('div',{},h('strong',{},labels[a.event]||a.event),h('div',{class:'hash'},`#${a.seq} · SHA-256 ${a.digest}`),h('details',{},h('summary',{},'查看业务证据'),h('pre',{},JSON.stringify(a.payload,null,2)))))));
}
function dataCell(label,value){return h('div',{},h('span',{},label),value);}
function receipt(n){
  const r=n.result;const box=h('div',{class:'receipt'},h('div',{class:'receipt-title'},'✓ 已完成 · 来自工具回执'));
  if(n.tool==='balance')box.append(h('strong',{},money(r.balance)),h('small',{},r.source));
  if(n.tool==='transfer')box.append(h('div',{},`${money(r.amount)} 已转入 ${n.recipient.name} 的模拟账户`),h('div',{},`回执编号 ${r.receipt}`),h('div',{},`交易后余额 ${money(r.balance)}`),h('small',{},'已结算模拟交易不能通过取消计划撤回'));
  if(n.tool==='bills'){
    box.append(h('div',{},`${r.month} 合成消费统计`),h('strong',{},money(r.total)));
    for(const c of r.categories)box.append(h('div',{class:'bill-row'},h('span',{},c.name),h('span',{},money(c.amount))));
    for(const a of r.alerts)box.append(h('p',{class:'warning'},`待核实异常：${a.merchant} ${money(a.amount)}，${a.reason}`));
    if(!r.alerts.length)box.append(h('p',{},'未发现规则覆盖范围内的短时重复交易，不代表没有其他异常。'));
    box.append(h('details',{},h('summary',{},`查看 ${r.records.length} 条合成明细`),...r.records.map(x=>h('div',{class:'bill-row'},h('span',{},`${x.occurred.slice(5,10)} ${x.merchant}`),h('span',{},money(x.amount))))),h('small',{},r.source));
  }
  if(n.tool==='subscriptions')for(const s of r.subscriptions)box.append(h('div',{class:'bill-row'},h('span',{},s.name),h('span',{},s.active?`${money(s.price)}/月 · 生效中`:'已取消')));
  if(n.tool==='cancel_subscription')box.append(h('div',{},`${n.subscription.name}：${r.alreadyCancelled?'此前已取消':'已取消未来续费'}`),h('small',{},r.effective));
  return box;
}
function renderPlan(p){
  const controls=h('div',{class:'plan-controls'});
  if(p.status==='active')controls.append(h('button',{class:'text-button',onclick:()=>control('pause')},'暂停'),h('button',{class:'text-button',onclick:()=>control('cancel')},'取消'),h('button',{class:'text-button',onclick:()=>control('handoff')},'人工接管'));
  if(p.status==='paused')controls.append(h('button',{class:'text-button',onclick:()=>control('resume')},'恢复'),h('button',{class:'text-button',onclick:()=>control('cancel')},'取消'));
  const view=$('#plan-view');view.replaceChildren(h('div',{class:'plan-top'},h('div',{},h('strong',{},statuses[p.status]),h('small',{},`版本 ${p.version} · 有效至 ${time(p.expires)} · ${p.id.slice(0,8)}`)),controls));
  if(p.lastChange){
    const c=p.lastChange;
    const evidence=h('details',{class:'change-evidence',open:''},h('summary',{},`授权差异凭证 · v${c.fromVersion} → v${c.toVersion}`));
    for(const x of c.changes)evidence.append(h('div',{class:'change-row'},h('b',{},`步骤 ${x.node.replace('n','')}：${x.before.recipient} ${money(x.before.args.amount)} → ${x.after.recipient} ${money(x.after.args.amount)}`),h('div',{},`${levelNames[x.before.level]} → ${levelNames[x.after.level]} · 执行后余额 ${money(x.before.balanceAfter)} → ${money(x.after.balanceAfter)}`)));
    evidence.append(h('small',{},c.invalidated+'。此处为变更时快照，最终执行会再次核算。'));view.append(evidence);
  }
  for(const [i,n]of p.nodes.entries()){
    const node=h('article',{class:'node'},h('div',{class:'node-head'},h('div',{class:'node-title'},h('span',{class:'node-index'},String(i+1).padStart(2,'0')),n.title),h('span',{class:`badge ${n.policy.level}`},levelNames[n.policy.level])));
    node.append(h('p',{class:'node-reason'},n.policy.reason+ (n.dependsOn.length?` · 依赖 ${n.dependsOn.join(', ')}`:' · 起始节点')));
    if(n.tool==='transfer')node.append(h('div',{class:'node-data'},dataCell('收款人',`${n.recipient.name} · ${n.recipient.account}`),dataCell('转账金额',money(n.args.amount)),dataCell('账户余额影响',n.status==='completed'?'见交易回执':`${money(n.impact.before)} → ${money(n.impact.after)}`),dataCell('费用 / 累计转账',`${money(n.impact.fee)} / ${money(n.policy.projectedDaily)}`)));
    if(n.tool==='cancel_subscription')node.append(h('div',{class:'node-data'},dataCell('订阅',n.subscription.name),dataCell('影响',`停止未来 ${money(n.subscription.price)}/月 续费`)));
    if(n.status==='completed')node.append(receipt(n));
    else if(p.status==='active'){
      const actions=h('div',{class:'node-actions'});
      if(n.tool==='transfer')actions.append(h('button',{class:'secondary',onclick:()=>openEdit(p,n)},'修改参数'));
      if(n.id===p.next)actions.append(h('button',{class:'primary',onclick:()=>openAuth(p,n)},n.policy.level==='red'?'审阅并强验证':'审阅并确认'));
      node.append(h('div',{class:'node-state'},n.id===p.next?'● 尚未执行，等待你的授权':'○ 等待前置任务完成'),actions);
    }else node.append(h('div',{class:'node-state'},p.status==='cancelled'?'未执行 · 已取消':p.status==='handoff'?'未执行 · 等待本地人工处理':'未执行 · 计划已暂停'));
    view.append(node);
  }
}
async function control(action){
  const p=current();try{await api(`/api/plans/${p.id}/control`,{action,version:p.version});await refresh();message(action==='handoff'?'已生成本地人工处理工单。未连接真实客服，也未继续执行。':'任务状态已更新。已完成的交易保持有效。');}catch(e){notify(e.message);}
}
async function openAuth(p,n){
  let review;
  try{review=await api(`/api/plans/${p.id}/review`,{node:n.id,version:p.version});}catch(e){notify(e.message);await refresh();return;}
  auth={plan:p.id,node:n.id,version:p.version,reviewToken:review.token};
  const terms=review.terms;
  $('#auth-title').textContent=n.title;
  $('#auth-details').replaceChildren(h('p',{class:'node-reason'},terms.policy.reason));
  if(n.tool==='transfer')$('#auth-details').append(h('div',{class:'node-data'},dataCell('收款人',n.recipient.name),dataCell('金额',money(terms.args.amount)),dataCell('执行后余额',money(terms.after)),dataCell('本笔后日累计',money(terms.policy.projectedDaily))));
  if(n.tool==='cancel_subscription')$('#auth-details').append(h('p',{},`取消${n.subscription.name}的未来续费，不退还历史扣款。`));
  if(n.tool==='subscriptions')$('#auth-details').append(h('p',{},'授权读取当前模拟账户的订阅清单，不改变合约。'));
  $('#code-area').classList.toggle('hidden',terms.policy.level!=='red');
  $('#request-code').classList.toggle('hidden',!!state.security?.required&&!!state.security?.enrolled);
  $('#request-code').textContent=state.security?.required?'前往安全设置绑定验证器':'生成本机演示验证码';
  $('#code-area .warning').textContent=state.security?.required?'填写手机验证器动态码。该码有效期30秒，已用过的码不能再次授权。':'同机演示码仅用于规则测试，不是生产级多因子认证。';
  $('#auth-error').textContent='';$('#demo-code').textContent='';$('#code').value='';$('#explicit-confirm').checked=false;
  $('#auth-dialog').showModal();
}
function openEdit(p,n){
  editing={plan:p.id,node:n.id,version:p.version,old:n};
  $('#recipient').replaceChildren(...state.contacts.map(c=>h('option',{value:c.id},`${c.name} · ${c.account}`)));
  $('#recipient').value=n.args.recipient;$('#amount').value=(n.args.amount/100).toFixed(2);$('#edit-error').textContent='';
  diff();$('#edit-dialog').showModal();
}
function diff(){
  if(!editing)return;const old=editing.old;
  const amount=Math.round(Number($('#amount').value)*100), recipient=state.contacts.find(c=>c.id===$('#recipient').value);
  const p=current();let cumulative=state.daily;
  for(const n of p.nodes){if(n.status==='pending' && n.tool==='transfer'){cumulative+=n.id===old.id?amount:n.args.amount;if(n.id===old.id)break;}}
  $('#edit-diff').replaceChildren(h('div',{},`收款人：${old.recipient.name} → ${recipient?.name||'待选择'}`),h('div',{},`金额：${money(old.args.amount)} → ${money(amount)}`),h('div',{},`预计风险：${levelNames[old.policy.level]} → ${levelNames[cumulative>100000?'red':'yellow']}`),h('div',{},`本步后预计余额：${money(old.impact.after)} → ${money(old.impact.before-amount)}`));
}
$('#chat-form').addEventListener('submit',async e=>{
  e.preventDefault();if(busy)return;const text=$('#prompt').value.trim();if(!text)return;
  busy=true;$('#send').disabled=true;$('#send').textContent='正在理解与规划…';notify();message(text,'user');
  try{
    const r=await api('/api/plan',{text});
    if(r.kind==='plan'){selected=r.plan.id;$('#prompt').value='';message(r.plan.status==='completed'?'查询已完成，结果来自本地数据。':'计划已生成。绿色查询已自动完成，其余步骤等待你审阅授权。');}
    else message(r.message);
    if(r.telemetry){const label=h('div',{class:'inference-evidence'},`${r.telemetry.model} · 本机推理 ${(r.telemetry.latencyMs/1000).toFixed(1)}秒 · ${r.telemetry.tokens||'—'} tokens`);$('#messages').append(label);$('#messages').scrollTop=$('#messages').scrollHeight;}
    await refresh();
  }catch(err){notify(err.message);message('这次请求未返回成功结果，请查看提示后重试。');}
  finally{busy=false;$('#send').disabled=false;$('#send').textContent='生成任务 →';}
});
$('#auth-form').addEventListener('submit',async e=>{
  e.preventDefault();if(!$('#explicit-confirm').checked)return;
  $('#authorize').disabled=true;$('#auth-error').textContent='';
  try{await api(`/api/plans/${auth.plan}/confirm`,{...auth,confirmed:true,code:$('#code').value});await refresh();$('#auth-dialog').close();message('当前步骤已执行，任务单中的回执来自实际模拟工具。');}
  catch(err){$('#auth-error').textContent=err.message;await refresh().catch(()=>{});}
  finally{$('#authorize').disabled=false;}
});
$('#request-code').addEventListener('click',async()=>{if(state.security?.required){$('#auth-dialog').close();document.querySelector('[data-tab="security"]').click();return;}try{const r=await api(`/api/plans/${auth.plan}/challenge`,auth);$('#demo-code').textContent=`本机演示码：${r.demoCode}，两分钟内有效。`;await refresh();}catch(e){$('#auth-error').textContent=e.message;}});
$('#edit-form').addEventListener('submit',async e=>{
  e.preventDefault();try{await api(`/api/plans/${editing.plan}/edit`,{node:editing.node,version:editing.version,amount:Math.round(Number($('#amount').value)*100),recipient:$('#recipient').value});$('#edit-dialog').close();await refresh();message('新计划已保存。请审阅变更后的参数与权限，旧授权已失效。');}catch(err){$('#edit-error').textContent=err.message;}
});
$('#amount').addEventListener('input',diff);$('#recipient').addEventListener('change',diff);
$('#dismiss-auth').addEventListener('click',()=>$('#auth-dialog').close());
$('#dismiss-edit').addEventListener('click',()=>$('#edit-dialog').close());
$('#plan-select').addEventListener('change',e=>{selected=e.target.value;render();});
$('#refresh').addEventListener('click',()=>refresh().catch(e=>notify(e.message)));
$('#begin-enroll').addEventListener('click',async()=>{try{const r=await api('/api/security/enroll',{});$('#enroll-secret').value=r.secret;$('#enroll-details').classList.remove('hidden');$('#security-message').textContent='请在10分钟内完成绑定。';}catch(e){$('#security-message').textContent=e.message;}});
$('#enroll-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/security/verify',{code:$('#enroll-code').value});$('#enroll-secret').value='';$('#enroll-code').value='';$('#enroll-details').classList.add('hidden');$('#security-message').textContent='绑定成功。为避免动态码重放，请等待手机显示下一枚新码，再授权第一笔红色操作。';await refresh();}catch(err){$('#security-message').textContent=err.message;}});
document.querySelectorAll('[data-prompt]').forEach(b=>b.addEventListener('click',()=>{$('#prompt').value=b.dataset.prompt;$('#prompt').focus();}));
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('.tab-content').forEach(el=>el.classList.toggle('hidden',el.id!==b.dataset.tab));
  document.querySelectorAll('[data-tab]').forEach(el=>el.classList.toggle('active',el===b));
}));
$('#export-audit').addEventListener('click',()=>{
  const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),auditValid:state.auditValid,scope:'当前会话最近120条记录；哈希链完整验证在服务端执行',records:state.audit},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=h('a',{href:url,download:'mingjian-audit.json'});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
refresh(true).then(engineStatus).catch(e=>notify('连接失败：'+e.message+'。请确认本机服务已启动。'));
setInterval(engineStatus,30000);

