import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs'
const html=readFileSync('public/index.html','utf8')
const source=readFileSync('worker.js','utf8')
if (!/export\s+default\s+/.test(source)) throw Error('Missing worker export')
const worker=source.replace(/export\s+default\s+/, 'const application = ')
const adapter=`
const page = ${JSON.stringify(html)};
export default {async fetch(request,env,ctx) {
  const path=new URL(request.url).pathname;
  if (path==="/" || path==="/index.html") return new Response(page,{headers:{"content-type":"text/html; charset=utf-8","x-content-type-options":"nosniff","referrer-policy":"same-origin","cache-control":"no-cache"}});
  if (!path.startsWith("/api/")) return new Response("Not found",{status:404});
  return application.fetch(request,env,ctx);
}};
`
mkdirSync('dist/server',{recursive:true})
mkdirSync('dist/.openai',{recursive:true})
copyFileSync('.openai/hosting.json','dist/.openai/hosting.json')
writeFileSync('dist/server/index.js',worker+'\n'+adapter)
