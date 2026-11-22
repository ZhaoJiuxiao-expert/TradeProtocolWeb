import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker,{canonical,sha256} from './worker.js';

const sql = new DatabaseSync(':memory:');
for(const name of ['0000_trade','0001_merchant_direct','0002_personal']) sql.exec(readFileSync(new URL('./drizzle/'+name+'.sql',import.meta.url),'utf8'));
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
  const r=await call('personal/state');return {cookie:r.headers.get('set-cookie').split(';')[0],...(await r.json())};
}
const state=async a=>(await call('personal/state',{headers:{cookie:a.cookie}})).json();
async function act(who,p,status=200,key=crypto.randomUUID()) {
  const r=await call('personal/action',{method:'POST',headers:{cookie:who.cookie,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(p)});
  const data=await r.json();assert.equal(r.status,status,JSON.stringify({action:p.action,data:data.error}));return data;
}
const seller=await account(),buyer=await account(),stranger=await account();
const listing={action:'list',title:'个人测试商品',price:12345,terms:'当面描述的测试条款',category:'camera',sellerName:'测试昵称',externalUrl:'https://www.goofish.com/item?id=135790',sellerAttested:true};
const number='99887766554433221',number2='233344445555777',typo='99887700000000001';
const confirm=(id,orderNumber=number)=>({action:'confirm',id,attested:true,orderNumber});
const ledger=async()=>(await call('personal/ledger')).json();
const offer=async()=>(await act(seller,listing)).actedId;
const fresh=async()=>{
  const id=await offer();await act(buyer,{action:'claim',id});return id;
};
for(const externalUrl of ['https://www.goofish.com.evil.invalid/item?id=123','https://www.goofish.com/item?id=123#test','https://www.goofish.com/item?id=123&utm=abc','http://www.goofish.com/item?id=123','https://www.goofish.com/item?id=123\n'])
  await act(seller,{...listing,externalUrl},400);
await act(seller,{...listing,sellerAttested:false},400);
const id=await offer();
await act(seller,{action:'claim',id},403);
await act(buyer,{action:'claim',id});
assert.equal((await ledger()).blocks.length,0);
assert(!(await state(stranger)).items.some(x=>x.id===id));
await act(stranger,confirm(id),403);
await act(buyer,{...confirm(id),attested:false},400);
await act(buyer,confirm(id,typo));
assert.equal((await ledger()).blocks.length,0);
await act(seller,confirm(id),409);
await act(buyer,{action:'cancel',id},409);
await act(buyer,confirm(id));
const k=crypto.randomUUID();
await Promise.all([act(seller,confirm(id),200,k),act(seller,confirm(id),200,k)]);
assert.equal((await ledger()).blocks.length,1);
assert.equal((await state(buyer)).items.find(x=>x.id===id).status,'completed');
const second=await fresh();
await act(seller,confirm(second),409);
await act(seller,confirm(second,number2));
assert.equal((await ledger()).blocks.length,1);
await act(buyer,confirm(second,number2));
assert.equal((await ledger()).blocks.length,2);
const parallel=await fresh(), third='12345555111133339';
await Promise.all([act(buyer,confirm(parallel,third)),act(seller,confirm(parallel,third))]);
assert.equal((await ledger()).blocks.length,3);
const disputed=await fresh();
await act(seller,{action:'dispute',id:disputed});
await act(buyer,confirm(disputed),409);
const cancellable=await fresh();
await act(seller,{action:'cancel',id:cancellable});
assert((await state(stranger)).items.some(x=>x.id===cancellable && x.status==='open' && !x.buyer));
const race=await Promise.all([buyer,stranger].map(a=>call('personal/action',{method:'POST',headers:{cookie:a.cookie,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({action:'claim',id:cancellable})})));
assert.deepEqual(race.map(x=>x.status).sort(),[200,409]);
const rolled=await fresh();
const rollNumber='1200009988111122';
await act(buyer,confirm(rolled,rollNumber));
sql.exec("CREATE TRIGGER force_failure BEFORE INSERT ON personal_blocks BEGIN SELECT RAISE(ABORT,'intentional test rollback'); END");
const saved=console.error;
try { console.error=()=>{};await act(seller,confirm(rolled,rollNumber),503); } finally {console.error=saved;}
assert.equal((await state(seller)).items.find(x=>x.id===rolled).sellerConfirmed,false);
assert.equal((await ledger()).blocks.length,3);
sql.exec('DROP TRIGGER force_failure');
await act(seller,confirm(rolled,rollNumber));
const full=await ledger();
let prev=full.anchor;
for(const [n,b] of full.blocks.entries()){
  const {hash,...data}=b;
  assert.deepEqual(Object.keys(b).sort(),['index','time','itemId','action','termsHash','orderCommitment','buyerHash','sellerHash','prevHash','hash'].sort());
  assert.equal(hash,await sha256(canonical(data)));assert.equal(b.index,n+1);assert.equal(b.prevHash,prev);prev=hash;
}
assert.equal(prev,full.head);
assert.equal(full.blocks.length,4);
const dbContents=['personal_items','personal_blocks','personal_receipts'].map(t=>JSON.stringify(sql.prepare('SELECT * FROM '+t).all())).join();
for(const value of [number,number2,typo,third,rollNumber]) {
  assert(!dbContents.includes(value));
  assert(!JSON.stringify(await state(buyer)).includes(value));
}
assert.equal((await (await call('real/ledger')).json()).blocks.length,0);
assert.equal((await (await call('ledger')).json()).blocks.length,0);
console.log('PASS migrations, exact Goofish allowlist, private single-sided declarations, independent matching and corrections, either order, idempotent retry, concurrent confirmations and competing claims, rollback, deduplication, frozen disputes and hash-chain verification.');
