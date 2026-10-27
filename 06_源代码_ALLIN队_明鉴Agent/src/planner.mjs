export const TOOLS = Object.freeze({
  balance: '查询账户余额', bills: '分析本月账单', transfer: '向联系人转账',
  subscriptions: '查询订阅', cancel_subscription: '取消订阅',
});
export const CONTACTS = Object.freeze([
  { id: 'zhangsan', name: '张三', phone: '13800001001', account: '模拟账户 · 1001', memo: '室友' },
  { id: 'lisi', name: '李四', phone: '13800001002', account: '模拟账户 · 1002', memo: '同学' },
  { id: 'wangli', name: '王莉', phone: '13800001003', account: '模拟账户 · 1003', memo: '妈妈' },
]);
export const SUBSCRIPTIONS = Object.freeze([
  { id: 'music', name: '音乐会员', price: 1800 },
  { id: 'video', name: '视频会员', price: 2500 },
  { id: 'cloud', name: '云盘会员', price: 1200 },
]);

export function validateDag(nodes) {
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 12) throw new Error('任务节点数须为1—12');
  const ids = new Set(nodes.map(n => n.id));
  if (ids.size !== nodes.length) throw new Error('节点编号重复');
  for (const n of nodes) {
    if (!TOOLS[n.tool] || !Array.isArray(n.dependsOn)) throw new Error('未注册工具或依赖格式错误');
    if (n.dependsOn.some(x => !ids.has(x))) throw new Error('依赖节点不存在');
  }
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('任务依赖存在环路');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of nodes.find(n => n.id === id).dependsOn) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  nodes.forEach(n => visit(n.id));
  return true;
}

export function parseIntent(input, context = {}) {
  const text = String(input ?? '').trim();
  const clarify = message => ({ kind: 'clarification', message });
  if (!text || text.length > 600) return clarify('请输入1—600字的业务需求。');
  if (/(忽略|绕过|跳过|关闭).{0,16}(规则|验证|确认|风控|权限)|system\s*:|<\/?system|developer\s*:|越狱|sudo|eval\(|执行.{0,4}(代码|命令)/i.test(text))
    return { kind: 'rejected', message: '检测到试图改变权限或执行代码的指令，未创建业务任务。安全策略由服务端独立执行。' };
  if (/定时|明天|后天|下周|每月|每天|下个月|AA|平摊|拆分|赎回|申购|理财|挂失|密码|银行卡|额度/.test(text))
    return clarify('离线版当前支持即时联系人转账、本月账单分析、订阅查询与取消。定时、AA、理财和卡片业务尚未实现，不会替你执行。');
  const clauses = text.split(/(?:然后|接着|再帮我|并且|同时|[；;，,。\n])/).map(x => x.trim()).filter(Boolean);
  if (clauses.length > 6) return clarify('一次最多描述6项业务，请分批处理。');
  const nodes = [];
  let lastRecipient = context.lastRecipient;
  for (const clause of clauses) {
    let tool, args = {};
    if (/(转|取消|停掉|关闭|停止|退订)/.test(clause) && /不要|别|不转|不取消|不想|如果|假如|是否|能不能|怎么|如何/.test(clause))
      return clarify('这句话包含否定、条件或咨询含义。请明确要创建的操作，尚未执行。');
    if (/美元|美金|港币|欧元|USD|HKD|EUR|\$/.test(clause)) return clarify('当前仅支持人民币模拟账户，不支持外币交易。');
    if (/(取消|停掉|关闭|停止|退订)/.test(clause)) {
      const sub = SUBSCRIPTIONS.filter(s => clause.includes(s.name) || clause.includes(s.name.replace('会员', '')));
      if (sub.length !== 1) return clarify('请说明要取消哪项订阅：音乐会员、视频会员或云盘会员。');
      tool = 'cancel_subscription'; args = { subscription: sub[0].id };
    } else if (/转|打给|汇给|付给/.test(clause)) {
      let contacts = CONTACTS.filter(c => clause.includes(c.name) || clause.includes(c.phone) || clause.includes(c.memo));
      if (!contacts.length && /他|她|同一个人/.test(clause) && lastRecipient) contacts = CONTACTS.filter(c => c.id === lastRecipient);
      if (contacts.length !== 1) return clarify('请明确一位已登记收款人：张三（室友）、李四（同学）、王莉（妈妈），或使用其完整模拟手机号。');
      const noPhone = clause.replace(/1\d{10}/g, '');
      const amounts = [...noPhone.matchAll(/(?:¥|￥)?\s*(-?\d+(?:\.\d+)?)\s*(万|千|百)?\s*(?:元|块)?/g)];
      if (amounts.length !== 1) return clarify('每项转账请填写一个明确金额，例如“给张三转200元”。');
      const scale = { 万: 10000, 千: 1000, 百: 100 }[amounts[0][2]] || 1;
      const value = Number(amounts[0][1]) * scale;
      if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 0.0001)
        return clarify('转账金额须大于0，且最多精确到分。');
      if (/不要|别转|不转|取消转|不想|如果|假如|是否|能不能|怎么|如何/.test(clause))
        return clarify('这句话包含否定、条件或咨询含义。请明确是否要创建转账任务；尚未转账。');
      tool = 'transfer'; args = { recipient: contacts[0].id, amount: Math.round(value * 100) };
      lastRecipient = contacts[0].id;
    } else if (/订阅|代扣|会员/.test(clause)) tool = 'subscriptions';
    else if (/账单|消费|花了|支出|异常交易/.test(clause)) {
      if (/去年|上月|上个月|年度|去年|202\d/.test(clause)) return clarify('离线版当前只提供本月模拟账单，请使用“分析本月账单”。');
      tool = 'bills';
    } else if (/余额|多少钱|资金/.test(clause)) tool = 'balance';
    else return clarify('这部分需求无法可靠识别：“' + clause.slice(0, 60) + '”。请改写为余额查询、即时转账、本月账单或订阅管理。');
    nodes.push({ id: `n${nodes.length + 1}`, tool, args, dependsOn: nodes.length ? [`n${nodes.length}`] : [] });
  }
  validateDag(nodes);
  return { kind: 'plan', nodes, context: { lastRecipient } };
}
