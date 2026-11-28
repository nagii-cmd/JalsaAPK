/* JALSA service worker — اللعبة تشتغل بدون إنترنت + التحديث التلقائي يبقى شغال
   - الصفحة (index.html): نجيب النسخة الجديدة من النت أول (إذا النت بطيء/مقطوع نفتح آخر نسخة محفوظة)
   - المكتبات (three / peerjs / خطوط / Firebase SDK): تنحفظ مرة وحدة وتفتح من الجهاز
   - اتصال الغرف (MQTT) وFirestore وتسجيل الدخول: ما نلمسها نهائياً
   هذا الملف ما تحتاج تعدله مع كل تحديث للعبة. */
"use strict";
const CORE="jalsa-sw-core",RT="jalsa-sw-rt";
const SCOPE=self.registration.scope,SCOPE_PATH=new URL(SCOPE).pathname;
const PAGE=new URL("index.html",SCOPE).href;
const PRE=["three.min.js","peerjs.min.js"].map(f=>new URL(f,SCOPE).href);
const FB="https://www.gstatic.com/firebasejs/10.14.1/";
const FB_ENTRY=["firebase-app.js","firebase-auth.js","firebase-firestore.js"].map(f=>FB+f);
const NET_WAIT=3500; /* إذا النت أبطأ من هذا نفتح النسخة المحفوظة، والجديدة تنحفظ بالخلفية */
const CDN=/^https:\/\/(www\.gstatic\.com\/firebasejs\/|fonts\.googleapis\.com\/|fonts\.gstatic\.com\/|cdnjs\.cloudflare\.com\/|cdn\.jsdelivr\.net\/npm\/(?!world-atlas)|unpkg\.com\/(?!world-atlas)|code\.jquery\.com\/)/;
const STATIC_DEST=["script","style","image","font","audio","video","manifest","worker"];

const isPage=u=>u.origin===location.origin&&(u.pathname===SCOPE_PATH||u.pathname===SCOPE_PATH+"index.html");
const okRes=(r,opaqueOk)=>!!r&&(r.status===200||(opaqueOk&&r.type==="opaque"));

async function put(name,key,res){try{const c=await caches.open(name);await c.put(key,res)}catch(e){}}

async function warmFirebase(){
  const rt=await caches.open(RT),seen=new Set(),q=FB_ENTRY.slice();
  while(q.length&&seen.size<60){
    const u=q.shift();if(seen.has(u))continue;seen.add(u);
    try{
      let r=await rt.match(u);
      if(!r){r=await fetch(u);if(!okRes(r))continue;await rt.put(u,r.clone())}
      const t=await r.clone().text();
      for(const m of t.matchAll(/(?:from|import)\s*["']((?:https:\/\/www\.gstatic\.com\/firebasejs\/|\.\/)[^"']+\.js)["']/g)){
        const x=new URL(m[1],u).href;if(x.indexOf(FB)===0)q.push(x)
      }
    }catch(e){}
  }
}

self.addEventListener("install",e=>{
  e.waitUntil((async()=>{
    const c=await caches.open(CORE);
    await Promise.all([PAGE].concat(PRE).map(async u=>{
      try{const r=await fetch(new Request(u,{cache:"reload"}));if(okRes(r))await c.put(u,r)}catch(x){}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener("activate",e=>{
  e.waitUntil((async()=>{
    try{const ks=await caches.keys();await Promise.all(ks.filter(k=>k.indexOf("jalsa-sw-")===0&&k!==CORE&&k!==RT).map(k=>caches.delete(k)))}catch(x){}
    await self.clients.claim();
    try{await warmFirebase()}catch(x){}
  })());
});

/* التحديث التلقائي يطلب منا نسخة جديدة قبل ما يسوي reload */
self.addEventListener("message",e=>{
  const d=e.data;if(!d||d.t!=="jalsa-refresh")return;
  const port=e.ports&&e.ports[0];
  e.waitUntil((async()=>{
    try{const r=await fetch(PAGE,{cache:"reload"});if(okRes(r))await put(CORE,PAGE,r.clone())}catch(x){}
    try{port&&port.postMessage(1)}catch(x){}
  })());
});

function offlinePage(){
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body dir="rtl" style="margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;font:16px sans-serif;text-align:center;padding:24px"><div><p>تحتاج إنترنت لأول مرة فقط حتى تنحفظ اللعبة على جهازك.</p><button onclick="location.reload()" style="padding:10px 24px;border-radius:99px;border:0;font:inherit">أعد المحاولة</button></div>',{status:200,headers:{"Content-Type":"text/html; charset=utf-8"}});
}

async function pageFetch(e){
  const c=await caches.open(CORE),cached=await c.match(PAGE);
  let saving=Promise.resolve();
  const net=fetch(PAGE,{cache:"no-cache"}).then(r=>{
    if(okRes(r))saving=put(CORE,PAGE,r.clone());
    return r;
  });
  e.waitUntil(net.then(()=>saving).catch(()=>{}));
  if(!cached)return net.catch(offlinePage);
  const slow=new Promise(res=>setTimeout(()=>res(cached),NET_WAIT));
  return Promise.race([net.then(r=>okRes(r)?r:cached,()=>cached),slow]);
}

async function cacheFirst(e,name,opaqueOk,revalidate){
  const req=e.request,c=await caches.open(name);
  const hit=await c.match(req,{ignoreVary:true});
  const go=()=>fetch(req).then(r=>{if(okRes(r,opaqueOk))c.put(req,r.clone()).catch(()=>{});return r});
  if(hit){if(revalidate)e.waitUntil(go().catch(()=>{}));return hit}
  return go();
}

self.addEventListener("fetch",e=>{
  const req=e.request;
  if(req.method!=="GET")return;
  let u;try{u=new URL(req.url)}catch(x){return}
  if(u.origin===location.origin){
    if(u.searchParams.has("_")||req.headers.has("range"))return; /* فحص التحديث: دايماً من النت */
    if(req.mode==="navigate"&&isPage(u)){e.respondWith(pageFetch(e));return}
    if(u.pathname===SCOPE_PATH+"sw.js"||isPage(u))return;
    if(STATIC_DEST.indexOf(req.destination)>=0)e.respondWith(cacheFirst(e,RT,false,true));
    return;
  }
  if(CDN.test(req.url)){
    const css=u.hostname==="fonts.googleapis.com";
    e.respondWith(cacheFirst(e,RT,css,css));
  }
});
