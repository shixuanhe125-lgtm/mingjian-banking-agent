import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Bank} from '../src/bank.mjs';
import {createServer} from '../server.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE||'playwright');
const output=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../test-results');await mkdir(output,{recursive:true});
let localBank,localServer;
if(!process.env.BASE_URL){localBank=new Bank();localServer=createServer(localBank);await new Promise(r=>localServer.listen(0,'127.0.0.1',r));}
const baseUrl=process.env.BASE_URL||`http://127.0.0.1:${localServer.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH?{executablePath:process.env.BROWSER_PATH}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'zh-CN',recordVideo:{dir:path.join(output,'video'),size:{width:1440,height:1050}}});
const page=await context.newPage();const errors=[];
page.on('response',async r=>{if(r.url().includes('/api/')&&r.status()>=400)console.error('API',r.status(),await r.text());});
page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE_ERROR',e.message);});
const results=[];
async function check(name,fn){await fn();results.push({name,status:'passed'});}
async function request(text){await page.locator('#prompt').fill(text);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);}
async function authorize(){await page.locator('#auth-dialog').waitFor({state:'visible'});await page.locator('#explicit-confirm').check();await page.locator('#authorize').click();try{await page.locator('#auth-dialog').waitFor({state:'hidden',timeout:6000});}catch(e){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});console.error('AUTH_ERROR',await page.locator('#auth-error').innerText(),await page.locator('#auth-dialog').innerText());throw e;}}
await page.goto(baseUrl);await page.locator('#balance').filter({hasText:'¥'}).waitFor();
await page.screenshot({path:path.join(output,'01-desktop.png'),fullPage:true});
await check('黄色计划与绿色查询',async()=>{
  await request('查询余额，然后给张三转200元');
  await page.getByText('尚未执行，等待你的授权',{exact:false}).waitFor();
  await page.screenshot({path:path.join(output,'02-plan.png'),fullPage:true});
});
await check('修改金额与权限差异',async()=>{
  await page.getByRole('button',{name:'修改参数'}).click();await page.locator('#amount').fill('1200');await page.locator('#recipient').selectOption('lisi');
  await page.getByText('预计风险：黄色 · 确认 → 红色 · 强验证',{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'03-edit.png'),fullPage:true});
  await page.locator('#edit-dialog').screenshot({path:path.join(output,'09-edit-detail.png')});
  await page.getByRole('button',{name:'保存新计划'}).click();await page.locator('#edit-dialog').waitFor({state:'hidden'});
  await page.getByText('授权差异凭证',{exact:false}).waitFor();
  await page.screenshot({path:path.join(output,'06-revision.png'),fullPage:true});
  await page.getByRole('button',{name:'审阅并强验证'}).click();await page.locator('#request-code').click();
  await page.waitForFunction(()=>document.querySelector('#demo-code').textContent.includes('本机演示码'));
  const code=(await page.locator('#demo-code').innerText()).match(/\d{6}/)[0];
  await page.locator('#code').fill(code);await authorize();await page.getByText('已转入 李四 的模拟账户',{exact:false}).waitFor();
  await page.screenshot({path:path.join(output,'07-receipt.png'),fullPage:true});
});
await check('账单分析',async()=>{await request('分析本月账单');await page.getByText('合成消费统计',{exact:false}).waitFor();await page.screenshot({path:path.join(output,'08-bills.png'),fullPage:true});});
await check('订阅查询与取消',async()=>{
  await request('查询订阅，然后取消视频会员');
  await page.getByRole('button',{name:'审阅并确认'}).click();await authorize();
  await page.getByRole('button',{name:'审阅并确认'}).click();await authorize();
  await page.getByText('视频会员：已取消未来续费',{exact:false}).waitFor();
});
await check('审计页面与链验证',async()=>{
  await page.locator('[data-tab="audit"]').click();await page.getByText('全部审计记录哈希链校验通过',{exact:false}).waitFor();
  await page.screenshot({path:path.join(output,'04-audit.png'),fullPage:true});
});
await check('窄屏无横向溢出',async()=>{
  await page.locator('[data-tab="workspace"]').click();await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(output,'05-mobile.png'),fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow)throw new Error('存在横向溢出');
});
if(errors.length)throw new Error(errors.join('\n'));
await context.close();await browser.close();
if(localServer)await new Promise(r=>localServer.close(()=>{localBank.close();r();}));
await writeFile(path.join(output,'browser-results.json'),JSON.stringify({results,pageErrors:errors},null,2));
console.log(JSON.stringify({checks:results.length,passed:results.length,pageErrors:errors.length}));

