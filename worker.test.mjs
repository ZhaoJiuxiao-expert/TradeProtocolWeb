import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, {canonical,sha256,references,initialState} from './worker.js';

const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
class Query {
  constructor(text, args=[]) { this.text=text; this.args=args; }
  bind(...args) { return new Query(this.text,args); }
  first() { return sql.prepare(this.text).get(...this.args); }
  run() { return sql.prepare(this.text).run(...this.args); }
}
const DB={
  prepare:text=>new Query(text),
  batch(rows) {
    sql.exec('BEGIN');
    try {
      const result=rows.map(q=>q.text.startsWith('SELECT')?{results:sql.prepare(q.text).all(...q.args)}:q.run());
      sql.exec('COMMIT');
      return result;
    } catch(e) { sql.exec('ROLLBACK'); throw e; }
  }
};
const call=(path,params={})=>worker.fetch(new Request('https://test.invalid/api/'+path,params),{DB});
async function account() {
  const r=await call('state');
  const cookie=r.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);
  return {cookie:cookie.split(';')[0],...(await r.json())};
}
async function act(a,p,key=crypto.randomUUID(),status=200) {
  const r=await call('action',{method:'POST',headers:{Cookie:a.cookie,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(p)});
  const data=await r.json(); assert.equal(r.status,status,JSON.stringify(data.error));
  return data;
}
const seller=await account(), buyer=await account(), stranger=await account();
assert.notEqual(seller.me,buyer.me);
assert.equal(seller.items.length,3);
const p={action:'list',title:'测试',category:'service',price:10001,stages:[{name:'一',amount:4000},{name:'二',amount:6001}],credit:100};
const created=await act(seller,p);
const id=created.actedId;
const item=s=>s.items.find(i=>i.id===id);
assert.equal(item(created).credit,80);
await act(seller,{action:'buy',id},undefined,403);
const key=crypto.randomUUID();
const copies=await Promise.all([act(buyer,{action:'buy',id},key),act(buyer,{action:'buy',id},key)]);
assert.equal(copies[0].balance,buyer.balance-10001);
assert.equal(copies[1].balance,copies[0].balance);
await act(buyer,{action:'dispute',id},key,409);
await act(stranger,{action:'deliver',id},undefined,403);
await act(seller,{action:'deliver',id});
const partial=await act(buyer,{action:'settle',id});
assert.equal(item(partial).feePaid,80);
assert.equal(item(partial).escrow,6001);
await act(buyer,{action:'dispute',id,reason:'测试'});
await act(buyer,{action:'resolve',id},undefined,403);
const resolved=await act(seller,{action:'resolve',id});
assert.equal(item(resolved).refunded,3001);
assert.equal(item(resolved).feePaid,140);
assert.equal(item(resolved).escrow,0);
assert.equal(resolved.balance,seller.balance+6860);
const demo=await act(buyer,{action:'buy',id:'demo-service'});
assert.equal(demo.items.find(i=>i.id===demo.actedId).status,'delivered');
assert.equal(demo.items.find(i=>i.id==='demo-service').status,'open');
const disputed=await act(buyer,{action:'dispute',id:demo.actedId});
assert.equal(disputed.items.find(i=>i.id===demo.actedId).status,'resolved');
const contested=await act(seller,{...p,title:'竞购'});
const race=await Promise.all([buyer,stranger].map(a=>call('action',{method:'POST',headers:{Cookie:a.cookie,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({action:'buy',id:contested.actedId})})));
assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
const won=await race.find(r=>r.status===200).json();
const winner=won.me===buyer.me?buyer:stranger;
await act(seller,{action:'deliver',id:contested.actedId});
await act(winner,{action:'settle',id:contested.actedId});
await act(seller,{action:'deliver',id:contested.actedId});
const closed=await act(winner,{action:'settle',id:contested.actedId});
assert.equal(closed.items.find(i=>i.id===contested.actedId).status,'closed');
assert.equal(closed.items.find(i=>i.id===contested.actedId).feePaid,200);
const readme=await call('ledger');
const ledger=await readme.json();
let prev=ledger.anchor;
for(const [n,b] of ledger.blocks.entries()) {
  const {hash,...data}=b;
  assert.equal(b.index,n+1);assert.equal(data.prevHash,prev);
  assert.equal(hash,await sha256(canonical(data)));prev=hash;
}
assert.equal(prev,ledger.head);
const sample=initialState().items['demo-camera'];
const history=Object.fromEntries([100,110,120,130,900,1000].map((price,j)=>[j,{...sample,price,seller:['a','a','a','a','b','c'][j],status:'closed',closedIndex:j}]));
assert.equal(references(history,sample).reference.median,900);
assert.equal(references(history,sample).orderReference.median,125);
assert.equal(references(history,{...sample,finish:'蓝'}).reference.median,null);
console.log('PASS SQLite transactions, same-key concurrency, role checks, installment fees, bilateral disputes, demo reuse, SHA-256 verification and comparable-sale medians.');
