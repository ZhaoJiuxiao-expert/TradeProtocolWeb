// Merchant-direct orders share only the existing anonymous session and request validation.
// Verified payment notifications, fund transfers and fulfillment are outside this API.
const realTransitions = {
  order: ['open','outside','awaiting_code'],
  code: ['awaiting_code','seller','awaiting_payment'],
  paid: ['awaiting_payment','buyer','buyer_paid'],
  payment_received: ['buyer_paid','seller','seller_received'],
  deliver: ['seller_received','seller','delivered'],
  receive: ['delivered','buyer','completed']
};
const paymentPattern = /^weixin:\/\/wxpay\/bizpayurl\?pr=[A-Za-z0-9_-]{4,128}$/;
const realActive = ['awaiting_payment','buyer_paid','seller_received','delivered'];
const realZero = '0'.repeat(64);

export function createRealApi({ensure,json,readAction,canonical,sha256}) {
  function field(value,max,name) {
    ensure(typeof value === 'string' && value.trim() && value.trim().length <= max && !/[\x00-\x08\x0B-\x1F]/.test(value), '请检查'+name);
    return value.trim();
  }
  function advance(item,actor,p,id,now) {
    const action = p.action;
    const time = new Date(now).toISOString();
    if(action==='list') {
      ensure(p.merchantAttested===true,'请确认你有权发布并履行此交易');
      ensure(['camera','game','service'].includes(p.category),'请选择有效类别');
      ensure(Number.isSafeInteger(p.price) && p.price>=1 && p.price<=100000000,'价格超出范围');
      return {id,title:field(p.title,80,'商品名称'),category:p.category,price:p.price,terms:field(p.terms,1200,'交付条款'),
        merchantName:field(p.merchantName,80,'收款商户名称'),merchantAttested:true,currency:'CNY',seller:actor,buyer:null,status:'open',
        disputer:null,createdAt:time,updatedAt:time,expiresAt:null,paymentUrl:null};
    }
    ensure(item,'未找到该订单',404);
    const role=actor===item.seller?'seller':actor===item.buyer?'buyer':'outside';
    if(action==='cancel') {
      ensure(role!=='outside','只有订单当事人可以取消',403);
      ensure(['open','awaiting_code'].includes(item.status),'出码后须通过争议流程处理',409);
      item.status='cancelled';
    } else if(action==='dispute') {
      ensure(role!=='outside','只有订单当事人可以发起争议',403);
      ensure(realActive.includes(item.status),'当前状态不能发起争议',409);
      item.disputer=actor; item.status='disputed';
    } else if(action==='close_dispute') {
      ensure(role!=='outside' && item.disputer!==actor,'需要另一方确认结束争议',403);
      ensure(item.status==='disputed','当前没有待处理的争议',409);
      item.status='closed_dispute';
    } else {
      ensure(typeof action==='string' && Object.hasOwn(realTransitions,action),'不支持的操作');
      const [previous,allowed,next] = realTransitions[action];
      ensure(role===allowed,'当前账户无权执行此操作',403);
      ensure(item.status===previous,'订单状态已变化，请刷新',409);
      if(action==='order') item.buyer=actor;
      if(action==='code') {
        ensure(typeof p.paymentUrl==='string' && paymentPattern.exec(p.paymentUrl)?.[0]===p.paymentUrl,'仅支持指定格式的微信支付 Native 订单链接');
        const expires=typeof p.expiresAt === 'string' ? Date.parse(p.expiresAt) : NaN;
        ensure(Number.isFinite(expires) && expires>now && expires<=now+7200000,'请填写实际订单到期时间，有效期须在两小时内');
        item.paymentUrl=p.paymentUrl; item.expiresAt=new Date(expires).toISOString();
      }
      item.status=next;
    }
    if(item.status!=='awaiting_payment') item.paymentUrl=null;
    item.updatedAt=time;
    return item;
  }
  async function listState(db,me,actedId) {
    const [items,blocks]=await db.batch([
      db.prepare("SELECT data FROM real_items WHERE status='open' OR seller=? OR buyer=? ORDER BY rowid DESC").bind(me,me),
      db.prepare('SELECT data FROM real_blocks ORDER BY idx DESC LIMIT 100')
    ]);
    return {me,actedId,mode:'merchant-direct',items:items.results.map(row=>{
      const i=JSON.parse(row.data);
      if(i.status!=='awaiting_payment' || Date.parse(i.expiresAt)<=Date.now() || (i.seller!==me && i.buyer!==me)) i.paymentUrl=null;
      return i;
    }),blocks:blocks.results.map(row=>JSON.parse(row.data)).reverse()};
  }
  async function commit(db,me,p,key) {
    const digest=await sha256(canonical(p));
    const id=p.action==='list'?crypto.randomUUID():p.id;
    ensure(typeof id==='string' && /^[0-9a-f-]{36}$/.test(id),'无效订单编号');
    for(let attempt=0;attempt<8;attempt++) {
      const [receipt,head,rows]=await db.batch([
        db.prepare('SELECT digest,item_id FROM real_receipts WHERE actor=? AND key=?').bind(me,key),
        db.prepare('SELECT data FROM real_blocks ORDER BY idx DESC LIMIT 1'),
        db.prepare('SELECT data FROM real_items WHERE id=?').bind(id)
      ]);
      const seen=receipt.results[0];
      if(seen) {
        ensure(seen.digest===digest,'请求编号已用于其他操作',409);
        return listState(db,me,seen.item_id);
      }
      const prev=head.results.length?JSON.parse(head.results[0].data):null;
      const item=advance(rows.results.length?JSON.parse(rows.results[0].data):null,me,p,id,Date.now());
      const agreed={id:item.id,currency:item.currency,price:item.price,title:item.title,merchantName:item.merchantName,seller:item.seller,category:item.category,terms:item.terms};
      item.termsHash=await sha256(canonical(agreed));
      const actorHash=await sha256(canonical(['merchant-direct-actor-v1',item.id,me]));
      const block={termsHash:item.termsHash,actorHash,index:(prev?.index??0)+1,time:item.updatedAt,itemId:id,action:p.action,role:me===item.seller?'seller':'buyer',status:item.status,prevHash:prev?.hash??realZero};
      block.hash=await sha256(canonical(block));
      const writes=[
        db.prepare('INSERT INTO real_blocks(idx,data) VALUES(?,?)').bind(block.index,JSON.stringify(block)),
        db.prepare('INSERT INTO real_items(id,seller,buyer,status,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET buyer=excluded.buyer,status=excluded.status,data=excluded.data').bind(id,item.seller,item.buyer,item.status,JSON.stringify(item)),
        db.prepare('INSERT INTO real_receipts(actor,key,digest,item_id) VALUES(?,?,?,?)').bind(me,key,digest,id)
      ];
      let codeDigest;
      if(p.action==='code') {
        codeDigest=await sha256('merchant-code:'+item.paymentUrl);
        writes.push(db.prepare('INSERT INTO real_used_codes(digest) VALUES(?)').bind(codeDigest));
      }
      try { await db.batch(writes); }
      catch(e) {
        const latest=await db.prepare('SELECT idx FROM real_blocks ORDER BY idx DESC LIMIT 1').first();
        if((latest?.idx??0)!==(prev?.index??0)) continue;
        if(codeDigest) {
          const used=await db.prepare('SELECT digest FROM real_used_codes WHERE digest=?').bind(codeDigest).first();
          ensure(!used,'此付款码已绑定过其他订单，请使用本单专用付款码',409);
        }
        throw e;
      }
      return listState(db,me,id);
    }
    ensure(false,'订单繁忙，请用同一请求编号重试',503);
  }
  return async function realApi(request,db,identity) {
    const url=new URL(request.url);
    const {me,cookie}=identity;
    if(url.pathname==='/api/real/state' && request.method==='GET')
      return json(await listState(db,me),200,cookie?{'Set-Cookie':cookie}:{});
    if(url.pathname==='/api/real/ledger' && request.method==='GET') {
      const {results}=await db.prepare('SELECT data FROM real_blocks ORDER BY idx').all();
      const blocks=results.map(r=>JSON.parse(r.data));
      return json({version:1,mode:'merchant-direct',algorithm:'SHA-256',anchor:realZero,blocks,head:blocks.at(-1)?.hash??realZero,
        encoding:'For each block remove hash, recursively sort keys in UTF-16 order, compact JSON.stringify, SHA-256 UTF-8 to lowercase hex; check index and prevHash in order.',
        commitments:'termsHash = SHA-256 of canonical JSON {id,currency,price,title,merchantName,seller,category,terms}; currency is CNY, price is integer fen. actorHash = SHA-256 of canonical JSON array ["merchant-direct-actor-v1", itemId, anonymousAccountId]. Hashes are lowercase hex. Confirmations are account declarations.',
        trust:'商家直收事件记录。确认来自买卖双方的自主声明，平台未核验实际资金流水或交付。运营方维护此账本，可下载快照比对。'},200,{'Content-Disposition':'attachment; filename="merchant-direct-ledger.json"'});
    }
    if(url.pathname==='/api/real/action' && request.method==='POST') {
      const origin=request.headers.get('Origin');
      ensure(!origin || origin===url.origin,'请求来源无效',403);
      ensure(!cookie,'请先打开平台以建立匿名账户',401);
      const p=await readAction(request);
      const key=request.headers.get('Idempotency-Key')??p.idempotencyKey;
      ensure(typeof key==='string' && /^[a-zA-Z0-9_-]{8,100}$/.test(key),'缺少有效请求编号');
      delete p.idempotencyKey;
      return json(await commit(db,me,p,key));
    }
    return json({error:'接口或请求方式无效'},404);
  };
}
