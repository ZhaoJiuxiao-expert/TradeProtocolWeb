// Only the local parties submit declarations. No credentials, requests or callbacks to Goofish.
export function createPersonalApi({ensure,json,readAction,canonical,sha256}) {
  const anchor='0'.repeat(64);
  const enc=new TextEncoder();
  const itemLink=/^https:\/\/www\.goofish\.com\/item\?id=[1-9][0-9]{0,30}$/;
  async function keyed(secret,parts) {
    const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const result=await crypto.subtle.sign('HMAC',key,enc.encode(canonical(parts)));
    return Array.from(new Uint8Array(result),b=>b.toString(16).padStart(2,'0')).join('');
  }
  function field(s,max,name) {
    ensure(typeof s==='string' && s.trim() && s.trim().length<=max && !/[\u0000-\u001F]/.test(s.trim()),'请检查'+name);
    return s.trim();
  }
  async function state(db,me,actedId) {
    const [items,blocks]=await db.batch([
      db.prepare("SELECT data FROM personal_items WHERE status='open' OR seller=? OR buyer=? ORDER BY rowid DESC").bind(me,me),
      db.prepare('SELECT data FROM personal_blocks ORDER BY idx DESC LIMIT 100')
    ]);
    return {me,actedId,mode:'goofish-direct',items:items.results.map(x=>JSON.parse(x.data)),blocks:blocks.results.map(x=>JSON.parse(x.data)).reverse()};
  }
  function listing(p,id,me,time) {
    ensure(p.sellerAttested===true,'请确认你是该商品卖家并有权履约');
    ensure(Number.isSafeInteger(p.price) && p.price>=1 && p.price<=100000000,'价格超出范围');
    ensure(['camera','game','service'].includes(p.category),'请选择有效类别');
    ensure(typeof p.externalUrl==='string' && itemLink.exec(p.externalUrl)?.[0]===p.externalUrl,'请填写规范的闲鱼商品链接');
    return {id,seller:me,buyer:null,sellerName:field(p.sellerName,80,'闲鱼昵称'),title:field(p.title,80,'商品名称'),terms:field(p.terms,1200,'交付条款'),
      price:p.price,currency:'CNY',category:p.category,externalUrl:p.externalUrl,status:'open',buyerConfirmed:false,sellerConfirmed:false,createdAt:time,updatedAt:time};
  }
  async function advance(me,p,id,old,secret) {
    const time=new Date().toISOString();
    if(p.action==='list') return {item:listing(p,id,me,time),orderKey:null};
    ensure(old,'未找到该登记',404);
    const item=JSON.parse(old.data);
    const role=me===item.seller?'seller':me===item.buyer?'buyer':null;
    let orderKey=old.order_key;
    switch(p.action) {
      case 'claim':
        ensure(me!==item.seller,'卖家不能登记为自己的买家',403);
        ensure(item.status==='open','商品已被登记或已下架',409);
        item.buyer=me;item.status='pending';break;
      case 'cancel':
        ensure(role,'只有当事方可撤销',403);
        ensure(['open','pending'].includes(item.status) && !item.buyerConfirmed && !item.sellerConfirmed,'已有确认或冻结，无法撤销',409);
        item.status=item.status==='open'?'withdrawn':'open';item.buyer=null;break;
      case 'dispute':
        ensure(role,'只有当事方可冻结登记',403);
        ensure(item.status==='pending','当前状态不支持争议',409);
        item.status='disputed';break;
      case 'confirm': {
        ensure(role,'只有买卖双方可提交确认',403);
        ensure(item.status==='pending','该登记已关闭或冻结',409);
        ensure(p.attested===true,'请确认已收货或货款已实际到账');
        ensure(typeof p.orderNumber==='string' && /^[0-9]{8,32}$/.exec(p.orderNumber)?.[0]===p.orderNumber,'请输入 8 至 32 位数字的闲鱼订单号');
        const proposed=await keyed(secret,['goofish-order',p.orderNumber]);
        const other=role==='seller'?'buyer':'seller';
        if(item[other+'Confirmed']) {
          ensure(proposed===orderKey,'双方填写的订单号不一致，请核对后再提交',409);
          item.status='completed';
        }
        orderKey=proposed;item[role+'Confirmed']=true;
        break;
      }
      default:ensure(false,'不支持的操作');
    }
    item.updatedAt=time;
    return {item,orderKey};
  }
  async function finalBlock(item,secret,orderKey,previous) {
    const {id,seller,sellerName,title,category,currency,price,terms,externalUrl}=item;
    const block={
      index:(previous?.index??0)+1,time:item.updatedAt,itemId:id,action:'dual_attestation',
      termsHash:await sha256(canonical({id,seller,sellerName,title,category,currency,price,terms,externalUrl})),
      orderCommitment:await keyed(secret,['goofish-attestation',id,orderKey]),
      buyerHash:await sha256(canonical(['goofish-party',id,item.buyer])),
      sellerHash:await sha256(canonical(['goofish-party',id,seller])),
      prevHash:previous?.hash??anchor
    };
    block.hash=await sha256(canonical(block));return block;
  }
  async function commit(db,me,p,key) {
    const id=p.action==='list'?crypto.randomUUID():p.id;
    ensure(typeof id==='string' && /^[0-9a-f-]{36}$/.test(id),'无效登记编号');
    await db.prepare('INSERT OR IGNORE INTO personal_clock(id,revision,secret) VALUES(1,0,?)').bind(crypto.randomUUID()+crypto.randomUUID()).run();
    for(let attempt=0;attempt<8;attempt++) {
      const [cfg,receipt,rows,head]=await db.batch([
        db.prepare('SELECT revision,secret FROM personal_clock WHERE id=1'),
        db.prepare('SELECT digest,item_id FROM personal_receipts WHERE actor=? AND key=?').bind(me,key),
        db.prepare('SELECT data,order_key FROM personal_items WHERE id=?').bind(id),
        db.prepare('SELECT data FROM personal_blocks ORDER BY idx DESC LIMIT 1')
      ]);
      const {revision,secret}=cfg.results[0];
      const digest=await keyed(secret,['goofish-request',p]);
      const seen=receipt.results[0];
      if(seen) {
        ensure(seen.digest===digest,'请求编号已用于其他操作',409);
        return state(db,me,seen.item_id);
      }
      const {item,orderKey}=await advance(me,p,id,rows.results[0],secret);
      const writes=[
        db.prepare('UPDATE personal_clock SET revision=CASE WHEN revision=? THEN revision+1 ELSE -1 END WHERE id=1').bind(revision),
        db.prepare('INSERT INTO personal_items(id,seller,buyer,status,order_key,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET buyer=excluded.buyer,status=excluded.status,order_key=excluded.order_key,data=excluded.data')
          .bind(id,item.seller,item.buyer,item.status,orderKey,JSON.stringify(item)),
        db.prepare('INSERT INTO personal_receipts(actor,key,digest,item_id) VALUES(?,?,?,?)').bind(me,key,digest,id)
      ];
      if(item.status==='completed') {
        const prev=head.results.length?JSON.parse(head.results[0].data):null;
        const block=await finalBlock(item,secret,orderKey,prev);
        writes.push(db.prepare('INSERT INTO personal_blocks(idx,item_id,data) VALUES(?,?,?)').bind(block.index,id,JSON.stringify(block)));
      }
      try {await db.batch(writes);}
      catch(e) {
        if((await db.prepare('SELECT revision FROM personal_clock WHERE id=1').first()).revision!==revision) continue;
        if(orderKey) {
          const used=await db.prepare('SELECT id FROM personal_items WHERE order_key=? AND id<>?').bind(orderKey,id).first();
          ensure(!used,'此订单号已用于其他登记',409);
        }
        throw e;
      }
      return state(db,me,id);
    }
    ensure(false,'登记繁忙，请用同一请求编号重试',503);
  }
  return async function personalApi(request,db,{me,cookie}) {
    const url=new URL(request.url);
    if(url.pathname==='/api/personal/state' && request.method==='GET')
      return json(await state(db,me),200,cookie?{'Set-Cookie':cookie}:{});
    if(url.pathname==='/api/personal/ledger' && request.method==='GET') {
      const {results}=await db.prepare('SELECT data FROM personal_blocks ORDER BY idx').all();
      const blocks=results.map(r=>JSON.parse(r.data));
      return json({version:1,mode:'goofish-direct',algorithm:'SHA-256',anchor,blocks,head:blocks.at(-1)?.hash??anchor,
        encoding:'Remove hash, serialize recursively sorted keys in UTF-16 order with compact JSON.stringify, SHA-256 UTF-8 to lowercase hex. Check successive index and prevHash.',
        commitments:'termsHash binds canonical {id,seller,sellerName,title,category,currency,price,terms,externalUrl}; buyerHash/sellerHash bind canonical ["goofish-party",itemId,accountId]. orderCommitment is an order-scoped HMAC over a private HMAC of the external number.',
        trust:'买家声明已收货，卖家声明货款已实际到账，双方各自输入的闲鱼订单号匹配。本站无法核验闲鱼订单、支付或退款。账本由本站维护。'},200,{'Content-Disposition':'attachment; filename="goofish-attestations.json"'});
    }
    if(url.pathname==='/api/personal/action' && request.method==='POST') {
      const origin=request.headers.get('Origin');
      ensure(!origin || origin===url.origin,'请求来源无效',403);ensure(!cookie,'请先打开平台以建立匿名账户',401);
      const p=await readAction(request);
      const key=request.headers.get('Idempotency-Key')??p.idempotencyKey;
      ensure(typeof key==='string' && /^[a-zA-Z0-9_-]{8,100}$/.test(key),'缺少有效请求编号');
      delete p.idempotencyKey;
      return json(await commit(db,me,p,key));
    }
    return json({error:'接口或请求方式无效'},404);
  };
}
