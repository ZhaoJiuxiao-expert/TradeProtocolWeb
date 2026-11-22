import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker,{canonical,sha256} from './worker.js';

const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
class Query {
  constructor(text, args=[]) { this.text=text; this.args=args; }
  bind(...args) { return new Query(this.text,args); }
  first() { return sql.prepare(this.text).get(...this.args); }
  run() { return sql.prepare(this.text).run(...this.args); }
  all() { return {results:sql.prepare(this.text).all(...this.args)}; }
}
const DB={
  prepare:text=>new Query(text),
  batch(rows) {
    sql.exec('BEGIN');
    try {
      const result=rows.map(q=>q.text.startsWith('SELECT')?q.all():q.run());
      sql.exec('COMMIT');return result;
    } catch(e) { sql.exec('ROLLBACK');throw e; }
  }
};
const call=(path,options={})=>worker.fetch(new Request('https://test.invalid/api/'+path,options),{DB});
async function account(){
  const r=await call('real/state');return {cookie:r.headers.get('set-cookie').split(';')[0],...(await r.json())};
}
const state=async a=>(await call('real/state',{headers:{cookie:a.cookie}})).json();
async function act(who,p,status=200,key=crypto.randomUUID()) {
  const r=await call('real/action',{method:'POST',headers:{cookie:who.cookie,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(p)});
  const data=await r.json();assert.equal(r.status,status,JSON.stringify({action:p.action,data:data.error}));return data;
}
const seller=await account(), buyer=await account(), stranger=await account();
const listing={action:'list',title:'测试商品',category:'service',merchantName:'测试商户',price:10000,terms:'按约交付',merchantAttested:true};
const qr='weixin://wxpay/bizpayurl?pr=LocalTestOnly';
const makeCode=(id,paymentUrl=qr)=>({action:'code',id,paymentUrl,expiresAt:new Date(Date.now()+3600000).toISOString()});
const anon=await call('real/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(listing)});
assert.equal(anon.status,401);
await act(seller,{...listing,merchantAttested:false},400);
const id=(await act(seller,listing)).actedId;
assert.equal((await state(buyer)).items.length,1);
await act(seller,{action:'order',id},403);
await act(buyer,{action:'order',id});
assert.equal((await state(stranger)).items.length,0);
await act(buyer,{action:'paid',id},409);
await act(buyer,makeCode(id),403);
for(const bad of ['https://wxpay.example/qr','weixin://wxpay/bizpayurl?pr=foo&extra=x',qr+'\n',qr+'#fragment',qr+'%00']) await act(seller,makeCode(id,bad),400);
for(const expiry of [Date.now()-1,Date.now()+7300000]) await act(seller,{...makeCode(id),expiresAt:new Date(expiry).toISOString()},400);
const key=crypto.randomUUID();
const issue=makeCode(id);
await Promise.all([act(seller,issue,200,key),act(seller,issue,200,key)]);
assert.equal((await state(buyer)).items[0].paymentUrl,qr);
assert.equal((await state(seller)).items[0].paymentUrl,qr);
assert(!JSON.stringify(await state(stranger)).includes(qr));
const clock=Date.now;
Date.now=()=>clock()+3700000;
assert.equal((await state(buyer)).items[0].paymentUrl,null);
Date.now=clock;
await act(seller,makeCode(id,qr+'swap'),409);
await act(buyer,{action:'cancel',id},409);
await act(seller,{action:'payment_received',id},409);
await act(stranger,{action:'paid',id},403);
await act(buyer,{action:'paid',id});
assert.equal((await state(buyer)).items[0].paymentUrl,null);
await act(seller,{action:'payment_received',id});
await act(buyer,{action:'deliver',id},403);
await act(seller,{action:'deliver',id});
await act(seller,{action:'receive',id},403);
assert.equal((await act(buyer,{action:'receive',id})).items[0].status,'completed');
const id2=(await act(seller,listing)).actedId;
await act(buyer,{action:'order',id:id2});
await act(seller,makeCode(id2),409);
await act(seller,makeCode(id2,qr+'Second'));
await act(buyer,{action:'dispute',id:id2});
await act(seller,{action:'payment_received',id:id2},409);
await act(buyer,{action:'close_dispute',id:id2},403);
await act(stranger,{action:'close_dispute',id:id2},403);
await act(seller,{action:'close_dispute',id:id2});
const cancelled=(await act(seller,listing)).actedId;
await act(buyer,{action:'order',id:cancelled});
await act(seller,{action:'cancel',id:cancelled});
const ledger=await (await call('real/ledger')).json();
let prev=ledger.anchor;
for(const [n,b] of ledger.blocks.entries()) {
  const {hash,...data}=b;
  assert.deepEqual(Object.keys(b).sort(),['index','time','itemId','action','role','status','prevHash','termsHash','actorHash','hash'].sort());
  if(b.itemId===id) {
    const {title,category,price,terms,merchantName}=listing;
    assert.equal(b.termsHash,await sha256(canonical({id,currency:'CNY',price,title,merchantName,seller:seller.me,category,terms})));
  }
  assert.equal(b.actorHash,await sha256(canonical(['merchant-direct-actor-v1',b.itemId,b.role==='buyer'?buyer.me:seller.me])));
  assert.equal(b.index,n+1);assert.equal(data.prevHash,prev);assert.equal(hash,await sha256(canonical(data)));prev=hash;
}
assert.equal(prev,ledger.head);
assert(!JSON.stringify(ledger).includes('LocalTestOnly'));
assert(!JSON.stringify(ledger).includes(seller.me));
assert.equal((await (await call('ledger')).json()).blocks.length,0);
assert.equal((await (await call('state',{headers:{cookie:buyer.cookie}})).json()).balance,1000000);
console.log('PASS private merchant-issued codes, expiry and reuse rejection, required merchant identity declaration, independent attestations, idempotent issue, cancellation/disputes, masked ledger, simulation separation.');
