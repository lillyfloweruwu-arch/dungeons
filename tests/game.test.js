const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
const plain=x=>JSON.parse(JSON.stringify(x));
function deferred(){ let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; }
function harness(autoInit=false){
  const storage=new Map(), elements=new Map(), timers=new Map(), events={};
  let now=100000, seq=0;
  function element(){ return {innerHTML:'',textContent:'',style:{},dataset:{},children:[],
    classList:{add(){},remove(){},toggle(){},contains(){return false;}},
    appendChild(x){this.children.push(x);},insertBefore(){},getContext(){return {};}}; }
  const get=id=>{ if(!elements.has(id)) elements.set(id,element()); return elements.get(id); };
  const doc={getElementById:get,createElement:element,querySelector:get,querySelectorAll:()=>[],
    body:element(),head:element(),addEventListener:(n,f)=>events[n]=f};
  const c=vm.createContext({document:doc,console:{warn(){}},performance:{now:()=>now},
    Date:class extends Date{static now(){return now;}},
    setTimeout:(fn,ms)=>{timers.set(++seq,{fn,at:now+ms,ms});return seq;},clearTimeout:id=>timers.delete(id),
    clearInterval(){},requestAnimationFrame(){},addEventListener:(n,f)=>events[n]=f,
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
  c.window=c;
  vm.runInContext(scripts[0],c);
  vm.runInContext(scripts[1].replace('  Online.init();',autoInit?'  Online.init();':''),c);
  return {c,storage,elements,timers,events,doc,run:code=>vm.runInContext(code,c),
    setNow:n=>now=n};
}
function account(h,read){
  h.run("SAVE_KEY='dungeon_legends_save_user_u'; hydrateSave({s:{gold:7}});");
  Object.assign(h.c.Online,{mode:'online',session:{user:{id:'u'}},
    sb:{from:()=>({select:()=>({eq:()=>({maybeSingle:()=>read(),single:()=>read()})})})}});
  return h.c.Online;
}

test('esc handles all HTML delimiters without trusting markup',()=>{
  const {c}=harness();
  assert.equal(c.esc('<img src="x" onerror=\'bad()\'>&'),'&lt;img src=&quot;x&quot; onerror=&#39;bad()&#39;&gt;&amp;');
});
test('validateCard follows every rule and returns trimmed copies',()=>{
  const {c}=harness();
  const good={q:' Question ',o:[' A ','B','C','D'],a:1};
  assert.deepEqual(plain(c.validateCard(good)),{ok:true,card:{q:'Question',o:['A','B','C','D'],a:1}});
  assert.equal(good.q,' Question ');
  for(const [input,reason] of [
    [null,'not an object'],[[],'not an object'],['text','not an object'],
    [{...good,q:undefined},'missing question'],[{...good,q:'  '},'missing question'],
    [{...good,q:'x'.repeat(301)},'question too long'],
    [{...good,o:['a','b','c']},'needs exactly 4 options'],
    [{...good,o:['a',2,'c','d']},'option 2 is empty or not text'],
    [{...good,o:['a','  ','c','d']},'option 2 is empty or not text'],
    [{...good,o:['a','x'.repeat(201),'c','d']},'option 2 is too long'],
    [{...good,o:['a',' A ','c','d']},'duplicate options'],
    ...[4,-1,1.5,'1',NaN].map(a=>[{...good,a},'answer index must be 0-3'])
  ]) assert.deepEqual(plain(c.validateCard(input)),{ok:false,reason});
  assert.equal(c.validateCard({...good,q:'x'.repeat(300),o:['x'.repeat(200),'b','c','d']}).ok,true);
  assert.equal(c.validateCard({q:'',o:[],a:4}).reason,'missing question');
});
test('imports and hydration use trimmed cards and report rejected reasons',()=>{
  const h=harness();
  const msg={};
  const result=h.c.parseJsonOrDs(JSON.stringify([
    {q:' Q ',o:[' A ','B','C','D'],a:0},null,{q:'Q',o:['a','A','c','d'],a:0}
  ]),msg);
  assert.equal(result.cards[0].q,'Q'); assert.equal(result.cards[0].o[0],'A');
  assert.equal(result.skipped,2);
  assert.match(h.c.cardRejections(result),/2 card\(s\) rejected: not an object; duplicate options/);
  h.run(`hydrateSave({s:{decks:[{id:'x',cards:[{q:' Q ',o:[' A ','B','C','D'],a:0},null]}]}});`);
  assert.equal(h.run('deck.length'),1); assert.equal(h.run('deck[0].q'),'Q');
});
test('fixed and scrambled options have unique text and exactly one correct button',()=>{
  const h=harness();
  h.run(`hydrateSave({s:{}});`);
  const q={q:'Q',o:[' Right ','right','wrong','other'],a:0};
  for(const scramble of [false,true]){
    h.run(`S.settings.scrambleAnswers=${scramble};`);
    for(let i=0;i<20;i++){
      const opts=h.c.buildOptions(q);
      assert.equal(opts.filter(o=>o.correct).length,1);
      assert.equal(new Set(opts.map(o=>o.text.toLowerCase())).size,opts.length);
    }
  }
});
test('legacy guest migration is non-destructive and account caches are isolated',()=>{
  const h=harness();
  h.storage.set('dungeon_legends_save_v1',JSON.stringify({s:{gold:31}}));
  h.c.Online.playOffline();
  assert.equal(h.run('S.gold'),31);
  assert.ok(h.storage.has('dungeon_legends_save_v1'));
  h.run("SAVE_KEY='dungeon_legends_save_user_u'; hydrateSave({s:{gold:80}}); save();");
  h.c.Online.playOffline();
  assert.equal(h.run('S.gold'),31);
  assert.equal(JSON.parse(h.storage.get('dungeon_legends_save_user_u')).s.gold,80);
});
test('cloud error falls back only to this account and never enables writes',async()=>{
  const h=harness(); const o=account(h,()=>({data:null,error:{message:'paused'}}));
  h.storage.set('dungeon_legends_save_user_u',JSON.stringify({s:{gold:42}}));
  let writes=0; o.sb.rpc=async()=>{writes++;return {};};
  assert.equal(await o.loadCloud(),true);
  assert.equal(h.run('S.gold'),42); assert.equal(o._cloudLoaded,false);
  await o.saveCloud(); assert.equal(writes,0);
  assert.equal(o._status,'Offline – will retry');
});
test('failed cloud read without cache never creates fresh state',async()=>{
  const h=harness(); const o=account(h,()=>({data:null,error:{message:'network'}}));
  assert.equal(await o.loadCloud(),false);
  assert.equal(h.run('S.gold'),7); assert.equal(o._cloudLoaded,false);
});
test('confirmed absence permits fresh state, malformed row does not',async()=>{
  const h=harness(); const o=account(h,()=>({data:null,error:null}));
  assert.equal(await o.loadCloud(),true); assert.equal(h.run('S.gold'),0);
  assert.equal(o._cloudLoaded,true);
  o.sb.from=()=>({select:()=>({eq:()=>({maybeSingle:()=>({data:{data:{s:[]}},error:null})})})});
  await o.loadCloud(); assert.equal(o._cloudLoaded,false);
});
test('offline choice invalidates delayed profile and cloud responses',async()=>{
  for(const stage of ['profile','save']){
    const h=harness(), wait=deferred();
    const o=account(h,()=>wait.promise);
    o.sb.rpc=()=>stage==='profile'?wait.promise:Promise.resolve({data:{best_floor:8}});
    const work=stage==='profile'?o.enterOnline({user:{id:'u'}}):o.loadCloud();
    o.playOffline(); h.run('S.gold=99; save();');
    wait.resolve({data:stage==='profile'?{best_floor:8}:{data:{s:{gold:1}},save_gen:0}});
    await work;
    assert.equal(h.run('S.gold'),99); assert.equal(o.mode,'offline'); assert.equal(o.profile,null);
  }
});
test('continuous activity has a 15 second maximum debounce',()=>{
  const h=harness(); const o=h.c.Online;
  o.saveCloudDebounced();
  for(let n=101000;n<=114000;n+=1000){h.setNow(n);o.saveCloudDebounced();}
  assert.equal(h.timers.get(o._saveTimer).at,115000);
});
test('save errors retain dirty work, back off, and retry successfully',async()=>{
  const h=harness(); const o=account(h,()=>({})); o._cloudLoaded=true;
  let fail=true, writes=0;
  o.sb.rpc=async()=>{writes++;return {error:fail?{message:'unavailable'}:null};};
  o.saveCloudDebounced(); await o.saveCloud();
  assert.equal(o._saved,0); assert.equal(o._status,'Offline – will retry');
  const due=o._retryAt; h.setNow(due-1); o.saveCloudDebounced(); await o.saveCloud();
  assert.equal(writes,1); assert.equal(h.timers.get(o._saveTimer).at,due);
  fail=false; h.setNow(due); await o.saveCloud();
  assert.equal(o._saved,o._dirty); assert.equal(o._status,'Saved');
});
test('score catch-up sends one step and advances only after success',async()=>{
  const h=harness(); const o=account(h,()=>({})); o._cloudLoaded=true; o._lastScore=3;
  let fail=true, sent=[];
  o.sb.rpc=async(name,args)=>{sent.push(args.p_floor);return {error:fail?{message:'cooldown'}:null};};
  await o.submitScore(20); assert.equal(o._lastScore,3); assert.deepEqual(sent,[4]);
  fail=false; h.timers.delete(o._scoreTimer); o._scoreTimer=null;
  await o.submitScore(20); assert.equal(o._lastScore,4); assert.deepEqual(sent,[4,4]);
});
test('stale generation reload discards both pending scores and old save responses',async()=>{
  const h=harness(); const o=account(h,()=>({data:{data:{s:{gold:0}},save_gen:2}}));
  o._cloudLoaded=true; o._lastScore=8; o._saveGen=1;
  const score=deferred();
  o.sb.rpc=async name=>name==='submit_score'?score.promise:{error:{message:'stale save generation'}};
  o.sb.from=table=>({select:()=>({eq:()=>({
    maybeSingle:async()=>({data:{data:{s:{gold:0}},save_gen:2}}),
    single:async()=>({data:{best_floor:0,banned:false}})})})});
  const pending=o.submitScore(10); o.saveCloudDebounced(); await o.saveCloud();
  score.resolve({}); await pending;
  assert.equal(o._saveGen,2); assert.equal(h.run('S.gold'),0);
  assert.equal(o._lastScore,0); assert.equal(o._scoreTarget,0); assert.equal(o._needsReload,false);
});
test('gate is present while SDK download is unresolved',()=>{
  const h=harness(true);
  assert.equal(h.doc.body.children[0].id,'authGate');
  assert.equal(h.doc.head.children[0].async,true);
  h.c.Online.playOffline(); assert.equal(h.c.Online.mode,'offline');
  assert.match(html,/media="print" onload=/); assert.ok(!html.includes('document.write'));
});
test('timed-out session restoration cannot later replace offline progress',async()=>{
  const h=harness(), wait=deferred();
  h.c.supabase={createClient:()=>({auth:{getSession:()=>wait.promise}})};
  const boot=h.c.Online.init(); await Promise.resolve();
  const timeout=[...h.timers.values()].find(t=>t.ms===6000);
  timeout.fn(); await boot;
  h.c.Online.playOffline(); h.run('S.gold=65;');
  wait.resolve({data:{session:{user:{id:'late'}}}}); await Promise.resolve();
  assert.equal(h.c.Online.mode,'offline'); assert.equal(h.run('S.gold'),65);
});
test('failed moderation reload stays write-blocked and retries',async()=>{
  const h=harness(); const o=account(h,()=>({error:{message:'unavailable'}}));
  let writes=0; o.sb.rpc=async()=>{writes++;return {};};
  await o.reloadModerated(o._bootGen);
  assert.equal(o._cloudLoaded,false); assert.equal(o._needsReload,true);
  h.setNow(o._retryAt); await o.saveCloud(); assert.equal(writes,0);
  assert.ok(o._retryAt>0);
});
test('visibility and pagehide attempt to flush pending cloud work',()=>{
  const h=harness(); let saves=0,scores=0;
  h.c.Online.saveCloud=()=>saves++; h.c.Online.submitScore=()=>scores++;
  h.doc.visibilityState='hidden'; h.events.visibilitychange(); h.events.pagehide();
  assert.equal(saves,2); assert.equal(scores,2);
});
test('imported names, stats and item IDs cannot break out of HTML',()=>{
  const h=harness(); const evil='<img src=x onerror="alert(1)">';
  h.c.payload=evil;
  h.run(`hydrateSave({s:{gold:payload,inventory:[{id:'1);alert(1)//',rarity:'common',
    type:'weapon',name:payload,atk:payload,unique:true,sig:payload}],
    decks:[{id:"x');alert(1)//",name:payload,cards:DEFAULT_DECK}],
    qstats:{'What is 7 × 8?':{seen:payload,correct:0}}}});
    renderInventory(); renderDecks(); renderDeckView(); renderHub();`);
  for(const id of ['invGrid','deckMgrList','deckList','deckSummary','hubStats']){
    const markup=h.elements.get(id).innerHTML;
    assert.ok(!markup.includes('<img'),id);
    assert.ok(!markup.includes('onclick="equipItem(1);'),id);
    assert.ok(!markup.includes("switchDeck('x');"),id);
  }
});
test('SQL fresh-install hardening matches migration and disables old write overloads',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'../supabase/002_hardening.sql'),'utf8');
  const setup=fs.readFileSync(path.join(__dirname,'../supabase/setup.sql'),'utf8');
  assert.ok(setup.endsWith(sql));
  assert.match(sql,/revoke execute on function public.save_game\(jsonb\) from public, anon, authenticated/);
  assert.match(sql,/revoke execute on function public.submit_score\(int\) from public, anon, authenticated/);
  assert.match(sql,/octet_length\(p_data::text\) > 204800/);
});
