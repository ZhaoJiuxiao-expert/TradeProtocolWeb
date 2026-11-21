import http from 'node:http'
import {DatabaseSync} from 'node:sqlite'
import {readFileSync,mkdirSync} from 'node:fs'
import app from './dist/server/index.js'
mkdirSync('.local',{recursive:true})
const sql=new DatabaseSync('.local/market.sqlite')
sql.exec(readFileSync('schema.sql','utf8'))
class Query {
  constructor(q,params=[]){this.q=q;this.params=params}
  bind(...p){return new Query(this.q,p)}
  first(column){const row=sql.prepare(this.q).get(...this.params);return column?row?.[column]??null:row??null}
  all(){return {results:sql.prepare(this.q).all(...this.params),success:true}}
  run(){const {changes,lastInsertRowid}=sql.prepare(this.q).run(...this.params);return {success:true,meta:{changes,last_row_id:Number(lastInsertRowid)}}}
}
const DB={prepare:q=>new Query(q),batch(stmts){
  sql.exec('BEGIN IMMEDIATE')
  try{const results=stmts.map(q=>/^\s*(SELECT|WITH)\b/i.test(q.q)?q.all():q.run());sql.exec('COMMIT');return results}
  catch(e){sql.exec('ROLLBACK');throw e}
}}
const port=Number(process.env.PORT || 4391)
http.createServer(async(req,res)=>{
 try{
  const chunks=[];let size=0
  for await(const b of req){size+=b.length;if(size>32768){res.writeHead(413).end();return}chunks.push(b)}
  const headers={...req.headers}; if(headers.cookie) headers.cookie=headers.cookie.replace(/(?:^|; )trade_local=/,m=>m.replace('trade_local=','__Host-trade_session='))
  const request=new Request('http://127.0.0.1:'+port+req.url,{method:req.method,headers,body:chunks.length?Buffer.concat(chunks):undefined})
  const out=await app.fetch(request,{DB})
  const outgoing=Object.fromEntries(out.headers); if(outgoing['set-cookie']) outgoing['set-cookie']=outgoing['set-cookie'].replace('__Host-trade_session=','trade_local=').replace('; Secure;',';');
  res.writeHead(out.status,outgoing);res.end(Buffer.from(await out.arrayBuffer()))
 }catch{res.writeHead(500).end('Local request failed')}
}).listen(port,'127.0.0.1',()=>console.log('Local site: http://127.0.0.1:'+port))
