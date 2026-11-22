import { createPersonalApi } from './personal-api.js';
import { createRealApi } from './real-api.js';
const ZERO = '0'.repeat(64);
const START = 1000000;
const categories = ['camera', 'game', 'service'];
const demoSeller = 'demo-seller';
const methods = ['list', 'buy', 'deliver', 'settle', 'dispute', 'resolve'];
const enc = new TextEncoder();

class Problem extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function ensure(ok, message, status) {
  if (!ok) throw new Problem(message, status);
}
function integer(x, min, max, name) {
  ensure(Number.isSafeInteger(x) && x >= min && x <= max, name + '超出范围');
  return x;
}
function label(x, length, name) {
  ensure(typeof x === 'string' && x.trim().length > 0 && x.trim().length <= length, '请检查' + name);
  return x.trim();
}
export async function sha256(s) {
  const bytes = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function canonical(x) {
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
  return JSON.stringify(x);
}
const median = xs => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a,b) => a-b);
  return Math.floor((sorted[(xs.length-1)>>1] + sorted[xs.length>>1] + 1)/2);
};
function comparable(i) {
  return canonical([i.category, i.model, i.kit, i.finish, i.condition, i.days <= 3 ? 1 : i.days <= 7 ? 2 : 3, i.warranty, i.credit >= 90 ? 3 : i.credit >= 70 ? 2 : 1]);
}
export function references(items, i) {
  const group = comparable(i);
  const peers = Object.values(items).filter(p => p.status === 'closed' && comparable(p) === group)
    .sort((a,b) => a.closedIndex-b.closedIndex).slice(-21);
  const sellers = new Map();
  for (const p of peers) {
    if (!sellers.has(p.seller)) sellers.set(p.seller, []);
    sellers.get(p.seller).push(p.price);
  }
  function summary(prices, source) {
    const center = sellers.size >= 3 ? median(prices) : null;
    const mad = center === null ? null : median(prices.map(p => Math.abs(p-center)));
    const unusual = center !== null && Math.abs(i.price-center) > Math.max(3*mad, Math.floor(center*0.15));
    return {median:center, count:peers.length, sellers:sellers.size, source, mad, flag:unusual ? (i.price>center ? 'high' : 'low') : null};
  }
  return {
    reference:summary([...sellers.values()].map(median), 'merchant-equal'),
    orderReference:summary(peers.map(p => p.price), 'order-weighted')
  };
}
function itemFrom(p, seller, id, items) {
  const title = label(p.title, 80, '名称');
  ensure(categories.includes(p.category), '请选择有效类别');
  const price = integer(p.price, 1, 100000000, '价格');
  const stages = p.stages ?? [{name:'交付验收',amount:price}];
  ensure(Array.isArray(stages) && stages.length >= 1 && stages.length <= 8, '阶段数应为 1 至 8');
  const steps = stages.map(s => ({name:label(s?.name,40,'阶段名称'),amount:integer(s?.amount,1,price,'阶段金额')}));
  ensure(steps.reduce((a,s)=>a+s.amount,0)===price, '阶段金额合计须等于总价');
  let condition = p.condition ?? 'A';
  if (typeof condition === 'number') {
    integer(condition,0,100,'成色');
    condition = condition >= 90 ? 'A' : condition >= 70 ? 'B' : 'C';
  }
  ensure(['A','B','C'].includes(condition), '成色须为 A、B 或 C');
  const prior = Object.values(items).filter(x=>x.seller===seller);
  const credit = Math.max(0, Math.min(100, 80 + 2*prior.filter(x=>x.status==='closed').length - 5*prior.filter(x=>x.status==='resolved').length));
  const i = {id,title,category:p.category,price,seller,buyer:null,status:'open',stage:0,stages:steps,
    feePaid:0,sellerGross:0,escrow:0,refunded:0,condition,days:integer(p.days??3,1,365,'交付天数'),
    warranty:integer(p.warranty??0,0,3650,'质保天数'),credit,model:label(p.model??title,80,'型号'),
    kit:label(p.kit??'标准',80,'配置'),finish:label(p.finish??'标准',40,'版本'),disputer:null,demo:seller===demoSeller};
  return Object.assign(i,references(items,i));
}
export function initialState() {
  const items = {};
  for (const p of [
    {id:'demo-camera',title:'富士 X-T30 II 机身',category:'camera',price:480000,model:'富士 X-T30 II'},
    {id:'demo-game',title:'独立游戏美术素材包',category:'game',price:6800},
    {id:'demo-service',title:'短片剪辑与调色',category:'service',price:80000,stages:[{name:'粗剪样片',amount:32000},{name:'调色成片',amount:48000}]}
  ]) items[p.id] = itemFrom(p,demoSeller,p.id,items);
  return {revision:0,items,accounts:{},fees:0,blocks:[]};
}
const balanceOf = (s, actor) => s.accounts[actor] ?? (actor===demoSeller ? 0 : START);
export async function transition(before, actor, p, {id,time}={id:crypto.randomUUID(),time:new Date().toISOString()}) {
  ensure(methods.includes(p.action),'不支持的操作');
  const state = structuredClone(before);
  const {items,accounts,blocks} = state;
  async function log(action, who, item, detail) {
    const block = {index:blocks.length+1,time,action,actor:who,itemId:item.id,detail,prevHash:blocks.at(-1)?.hash??ZERO};
    block.hash = await sha256(canonical(block));
    blocks.push(block);
  }
  if (p.action==='list') {
    ensure(!Object.hasOwn(items,id),'商品编号重复',409);
    const item = itemFrom(p,actor,id,items);
    items[id] = item;
    await log('list',actor,item,{title:item.title,category:item.category,price:item.price,stages:item.stages,model:item.model,kit:item.kit,finish:item.finish,days:item.days,warranty:item.warranty,credit:item.credit,condition:item.condition});
    return state;
  }
  ensure(typeof p.id==='string' && Object.hasOwn(items,p.id),'商品不存在',404);
  let i = items[p.id];
  const requireStatus = (...allowed) => ensure(allowed.includes(i.status),'交易状态已变化，请刷新',409);
  const permit = ok => ensure(ok,'当前账户无权执行此操作',403);
  async function deliver(who) {
    requireStatus('funded'); permit(who===i.seller); i.status='delivered';
    await log('deliver',who,i,{stage:i.stage,automatic:i.demo});
  }
  function paySeller(gross) {
    const totalGross = i.sellerGross + gross;
    const totalFee = Math.floor((totalGross*2 + 50)/100);
    const fee = totalFee - i.feePaid;
    accounts[i.seller] = balanceOf(state,i.seller)+gross-fee;
    i.sellerGross=totalGross; i.feePaid=totalFee; state.fees+=fee; i.escrow-=gross;
    return fee;
  }
  async function resolve(who) {
    requireStatus('disputed');
    permit((who===i.seller || who===i.buyer) && who!==i.disputer);
    const sellerGross = Math.floor(i.escrow/2);
    const refund = i.escrow-sellerGross;
    const fee = paySeller(sellerGross);
    accounts[i.buyer]=balanceOf(state,i.buyer)+refund;
    i.escrow-=refund; i.refunded+=refund; i.status='resolved';
    await log('resolve',who,i,{sellerGross,refund,fee,automatic:i.demo && who===demoSeller});
  }
  switch(p.action) {
    case 'buy':
      requireStatus('open'); permit(actor!==i.seller);
      ensure(balanceOf(state,actor)>=i.price,'模拟余额不足',409);
      if (i.demo && !i.templateId) {
        i = {...i,id,templateId:i.id};
        items[id] = i;
      }
      accounts[actor]=balanceOf(state,actor)-i.price;
      Object.assign(i,references(items,i));
      i.buyer=actor; i.escrow=i.price; i.status='funded';
      await log('buy',actor,i,{escrow:i.escrow,simulation:true});
      if (i.demo) await deliver(demoSeller);
      break;
    case 'deliver': await deliver(actor); break;
    case 'settle': {
      requireStatus('delivered'); permit(actor===i.buyer);
      const stage = i.stage;
      const gross = i.stages[stage].amount;
      const fee = paySeller(gross);
      i.stage++;
      i.status=i.stage===i.stages.length?'closed':'funded';
      if(i.status==='closed') i.closedIndex=blocks.length+1;
      await log('settle',actor,i,{stage,gross,fee,escrow:i.escrow,status:i.status});
      if(i.demo && i.status==='funded') await deliver(demoSeller);
      break;
    }
    case 'dispute':
      requireStatus('funded','delivered'); permit(actor===i.seller||actor===i.buyer);
      i.status='disputed'; i.disputer=actor;
      i.reason=p.reason ? label(p.reason,160,'争议说明') : '';
      await log('dispute',actor,i,{escrow:i.escrow,proposal:'split-remaining-equally',reason:i.reason});
      if(i.demo && actor!==demoSeller) await resolve(demoSeller);
      break;
    case 'resolve': await resolve(actor); break;
  }
  return state;
}
async function load(db) {
  const reads = [
    'SELECT revision,fees FROM trade_clock WHERE id=1',
    'SELECT id,data FROM trade_items',
    'SELECT id,balance FROM trade_accounts',
    'SELECT data FROM trade_blocks ORDER BY idx'
  ];
  const result = await db.batch(reads.map(sql=>db.prepare(sql)));
  const s = initialState();
  const clock = result[0].results[0];
  if (clock) Object.assign(s,clock);
  for(const row of result[1].results) s.items[row.id]=JSON.parse(row.data);
  for(const row of result[2].results) s.accounts[row.id]=row.balance;
  s.blocks=result[3].results.map(row=>JSON.parse(row.data));
  return s;
}
function view(s, me, actedId) {
  const items = Object.values(s.items).map(i=>i.status==='open' ? {...i,...references(s.items,i)} : i);
  return {me,balance:balanceOf(s,me),fees:s.fees,items,blocks:s.blocks,mode:'shared-simulation',actedId};
}
async function commitAction(db, me, p, key) {
  const digest = await sha256(canonical(p));
  const context = {id:crypto.randomUUID(),time:new Date().toISOString()};
  await db.prepare('INSERT OR IGNORE INTO trade_clock(id,revision) VALUES(1,0)').run();
  for(let attempt=0; attempt<8; attempt++) {
    const s=await load(db);
    const seen=await db.prepare('SELECT digest,item_id FROM trade_receipts WHERE actor=? AND key=?').bind(me,key).first();
    if (seen) {
      ensure(seen.digest===digest,'该请求编号已用于另一项操作',409);
      return view(await load(db),me,seen.item_id);
    }
    const next=await transition(s,me,p,context);
    const newBlocks=next.blocks.slice(s.blocks.length);
    const actedId=newBlocks[0].itemId;
    const writes=[
      db.prepare('UPDATE trade_clock SET revision=CASE WHEN revision=? THEN revision+1 ELSE -1 END,fees=? WHERE id=1').bind(s.revision,next.fees),
      db.prepare('INSERT INTO trade_items(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').bind(actedId,JSON.stringify(next.items[actedId])),
      db.prepare('INSERT INTO trade_receipts(actor,key,digest,item_id) VALUES(?,?,?,?)').bind(me,key,digest,actedId)
    ];
    for (const account of Object.keys(next.accounts)) {
      if(next.accounts[account]!==s.accounts[account])
        writes.push(db.prepare('INSERT INTO trade_accounts(id,balance) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET balance=excluded.balance').bind(account,next.accounts[account]));
    }
    for (const block of newBlocks) writes.push(db.prepare('INSERT INTO trade_blocks(idx,data) VALUES(?,?)').bind(block.index,JSON.stringify(block)));
    try {
      await db.batch(writes);
      return view(next,me,actedId);
    } catch(e) {
      const current=await db.prepare('SELECT revision FROM trade_clock WHERE id=1').first();
      if(current?.revision===s.revision) throw e;
    }
  }
  throw new Problem('交易繁忙，请用同一请求编号重试',503);
}
const ledgerFormat = {
  version:1,algorithm:'SHA-256',anchor:ZERO,
  encoding:'UTF-8 JSON. Remove hash from each block. Recursively sort object keys by JavaScript UTF-16 order, retain array order, use JSON.stringify for strings and primitives and omit whitespace. Hash the resulting bytes as lowercase hex. Verify index starts at 1, increases by 1, and prevHash equals the previous hash or anchor.',
  trust:'单站数据库公开事件记录，运营方可以重写记录。可保存快照并比较历史哈希。所有余额和收款均为模拟。'
};
async function identity(request) {
  const match = /(?:^|;\s*)__Host-trade_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('Cookie')??'');
  const token = match?.[1] ?? Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  return {me:'u-'+(await sha256('trade-account:'+token)).slice(0,32),cookie:match ? null : '__Host-trade_session='+token+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000'};
}
function json(data, status=200, headers={}) {
  return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
}
async function readAction(request) {
  ensure((request.headers.get('Content-Type')??'').split(';')[0].trim()==='application/json','请提交 JSON',415);
  const reader=request.body?.getReader();
  ensure(reader,'缺少操作内容');
  const decoder=new TextDecoder();
  let size=0, body='';
  while(true) {
    const {done,value}=await reader.read();
    if(done) break;
    size+=value.length;
    if(size>12000) { await reader.cancel(); throw new Problem('内容过长',413); }
    body+=decoder.decode(value,{stream:true});
  }
  let p;
  try { p=JSON.parse(body+decoder.decode()); } catch { throw new Problem('JSON 格式错误'); }
  ensure(p && typeof p==='object' && !Array.isArray(p),'请求格式错误');
  return p;
}
const personalApi = createPersonalApi({ensure,json,readAction,canonical,sha256});
const realApi = createRealApi({ensure,json,readAction,canonical,sha256});
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      const db=env.DB;
      if (url.pathname.startsWith('/api/personal/')) return await personalApi(request,db,await identity(request));
      if (url.pathname.startsWith('/api/real/')) return await realApi(request,db,await identity(request));
      if(url.pathname==='/api/ledger' && request.method==='GET') {
        const s=await load(db);
        return json({...ledgerFormat,blocks:s.blocks,head:s.blocks.at(-1)?.hash??ZERO},200,{'Content-Disposition':'attachment; filename="trade-ledger.json"'});
      }
      const {me,cookie}=await identity(request);
      if(url.pathname==='/api/state' && request.method==='GET') return json(view(await load(db),me),200,cookie ? {'Set-Cookie':cookie} : {});
      if(url.pathname==='/api/action' && request.method==='POST') {
        const origin=request.headers.get('Origin');
        ensure(!origin || origin===url.origin,'请求来源无效',403);
        ensure(!cookie,'请先打开平台以建立匿名账户',401);
        const p=await readAction(request);
        const key=request.headers.get('Idempotency-Key')??p.idempotencyKey;
        ensure(typeof key==='string' && /^[a-zA-Z0-9_-]{8,100}$/.test(key),'缺少有效请求编号');
        delete p.idempotencyKey;
        return json(await commitAction(db,me,p,key));
      }
      return json({error:'接口或请求方式无效'},404);
    } catch(e) {
      if(!(e instanceof Problem)) console.error('trade request failed',e?.message);
      return json({error:e instanceof Problem ? e.message : '交易服务暂时不可用，请稍后重试'},e instanceof Problem ? e.status : 503);
    }
  }
};
