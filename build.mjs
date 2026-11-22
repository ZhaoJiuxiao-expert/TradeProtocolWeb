import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs'
const read=p=>readFileSync(p,'utf8')
const original=read('worker.js')
function embedFactory(source,file,name){
  const line="import { "+name+" } from './"+file+"';"
  if(!source.includes(line)) throw Error('Missing worker dependency: '+file)
  const module=read(file).replace(/^export\s+(?=(?:async\s+)?(?:function|const|class|let)\b)/gm,'')
  return source.replace(line,()=>`const ${name}=(()=>{\n${module}\nreturn ${name};})();`)
}
const source=embedFactory(embedFactory(original,'real-api.js','createRealApi'),'personal-api.js','createPersonalApi')
if(!/export\s+default\s+/.test(source)) throw Error('Missing worker export')
const routes={'/':read('public/index.html'),'/direct':read('public/direct.html'),'/personal':read('public/personal.html'),'/qr-lib.js':read('vendor/qr-lib.js')}
const adapter=`
const pages=${JSON.stringify(routes)};
export default {async fetch(request,env,ctx){
  let path=new URL(request.url).pathname;
  if(path==='/index.html') path='/';
  if(path==='/direct.html'||path==='/direct/') path='/direct';
  if(path==='/personal.html'||path==='/personal/') path='/personal';
  if(Object.hasOwn(pages,path)){
    const headers={'content-type':path.endsWith('.js')?'application/javascript; charset=utf-8':'text/html; charset=utf-8','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','cache-control':'no-cache'};
    return new Response(request.method==='HEAD'?null:pages[path],{headers});
  }
  if(!path.startsWith('/api/')) return new Response('Not found',{status:404});
  return application.fetch(request,env,ctx);
}};
`;
mkdirSync('dist/server',{recursive:true});mkdirSync('dist/.openai',{recursive:true})
copyFileSync('.openai/hosting.json','dist/.openai/hosting.json')
writeFileSync('dist/server/index.js',source.replace(/export\s+default\s+/,'const application = ')+adapter)
