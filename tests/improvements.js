(async () => {
  const checks = [];
  const scripts=[...document.scripts].map(script=>script.getAttribute('src')||'');
  const localAuth=scripts.includes('vendor/supabase-2.117.2.min.js');
  const localCharts=scripts.includes('vendor/lightweight-charts-4.2.0.js');
  checks.push({name:'startup SDK is bundled locally and usable',pass:localAuth && typeof window.supabase?.createClient==='function'});
  checks.push({name:'chart dependency is bundled locally and usable',pass:localCharts && typeof window.LightweightCharts?.createChart==='function'});

  const check = (name, value) => checks.push({ name, pass: !!value, detail: value ? '' : 'regression reproduced' });
  const originalUser = _currentUser;
  const originalGeneration = typeof _accountGeneration === 'number' ? _accountGeneration : null;
  if (typeof _accountContext === 'function') {
    _currentUser = { id: 'synthetic-A' };
    const account = _accountContext();
    check('account guard accepts original account', _accountCurrent(account));
    _setCurrentUser({ id: 'synthetic-B' });
    check('account guard rejects changed account', !_accountCurrent(account));
    _setCurrentUser({ id: 'synthetic-A' });
    check('account guard rejects A-B-A generation change', !_accountCurrent(account));
    _setCurrentUser(null);
    check('account guard rejects signout', !_accountCurrent(account));
    _currentUser = originalUser;
    _accountGeneration = originalGeneration;
  } else check('account-generation guard exists', false);

  for (const fn of [checkAndSaveHistory, loadUserData]) {
    let release;
    let current = 'synthetic-A';
    const wait = new Promise(resolve => { release = resolve; });
    const writes = [];
    let reconciled = false;
    const chain = { eq: () => chain, maybeSingle: () => wait, then: (a,b) => wait.then(a,b) };
    const sb = { from: () => ({ select: () => chain, upsert: async rows => { writes.push(rows); } }) };
    const ctx = () => ({ userId: 'synthetic-A', generation: 0 });
    const isCurrent = account => current === account.userId;
    // Evaluate the actual production function with synthetic boundaries, not
    // a copied implementation. Legacy code's global user sees the switch too.
    const fakeUser = { get id() { return current; } };
    const run = new Function('_sb','_accountContext','_accountCurrent','_currentUser',
      'activeScreener','_scanToken','firstSeenByTicker','newToday','watchlist','_fsKey','_reconcilePrefs',
      'return (' + fn.toString() + ');')
      (sb,ctx,isCurrent,fakeUser,'sepa',1,new Map(),new Set(),new Set(),(s,t)=>s+':'+t,()=>{reconciled=true;});
    const pending = fn === checkAndSaveHistory ? run(['SYNTHETIC']) : run();
    current = 'synthetic-B';
    release({data:[],error:null});
    let error = null;
    try { await pending; } catch(e) { error = e; }
    check(fn.name + ': delayed A response after B switch is discarded', !error && !writes.length && !reconciled);
  }

  if (typeof _galleryBarsFromValidated === 'function') {
    const now = Date.now();
    const bars = Array.from({length:250}, (_,i) => ({t:Math.floor(now/1000)-(249-i)*86400,o:100,h:101,l:99,c:100,v:1000}));
    _valBars.set('SYNTHETIC-CACHE',{bars,t:now,key:_closedSessionKey(now)});
    const reused = await _galleryBarsFromValidated('SYNTHETIC-CACHE',now);
    check('gallery reuses validated bars in a 90-day window', reused?.length===91 && reused[0].t===bars[159].t);
    check('gallery reuse does not trim source validation history', _valBars.get('SYNTHETIC-CACHE').bars.length===250);
    _valBars.set('SYNTHETIC-CACHE',{bars,t:now-31*60*1000,key:null});
    check('gallery rejects expired validation data', await _galleryBarsFromValidated('SYNTHETIC-CACHE',now)===null);
    _valBars.delete('SYNTHETIC-CACHE');
    check('gallery missing data preserves normal network fallback', await _galleryBarsFromValidated('SYNTHETIC-CACHE',now)===null);
    let release;
    const inFlight = new Promise(resolve=>{release=resolve;});
    _warmInflight.set('SYNTHETIC-CACHE',inFlight);
    const reusedPending = _galleryBarsFromValidated('SYNTHETIC-CACHE',now);
    _valBars.set('SYNTHETIC-CACHE',{bars,t:now,key:_closedSessionKey(now)});
    release();
    check('gallery shares in-flight validation instead of a second fetch', (await reusedPending)?.length===91);
    _warmInflight.delete('SYNTHETIC-CACHE'); _valBars.delete('SYNTHETIC-CACHE');
  } else check('gallery validation-cache reuse exists', false);
  {
    const get=_barsStore.get,batch=_fetchBars1yBatch;
    const tickers=Array.from({length:120},(_,i)=>'SYNTHETIC-EARLY-'+i);
    let releaseSlow;const slow=new Promise(resolve=>{releaseSlow=resolve;});
    const now=Date.now(),bars=Array.from({length:250},(_,i)=>({t:Math.floor(now/1000)-(249-i)*86400,o:100,h:101,l:99,c:100,v:1000}));
    let complete=false;
    try{
      _barsStore.get=async()=>null;
      _fetchBars1yBatch=async symbols=>{
        if(symbols.includes(tickers[60]))await slow;
        for(const sym of symbols)_valBars.set(sym,{bars,t:now,key:_closedSessionKey(now)});
      };
      const all=_fetchBars1yWarm(tickers).then(()=>{complete=true;});
      let ready=false;
      await Promise.race([_galleryBarsFromValidated(tickers[0],now).then(value=>{ready=!!value;}),new Promise(resolve=>setTimeout(resolve,100))]);
      check('first ready stock chart does not wait for unrelated slow batch',ready && !complete);
      releaseSlow();await all;
      check('early stock availability still completes every validation batch',complete && tickers.every(sym=>_valBars.has(sym)));
      check('early stock availability clears all in-flight ownership',tickers.every(sym=>!_warmInflight.has(sym)));
    }finally{releaseSlow();_barsStore.get=get;_fetchBars1yBatch=batch;tickers.forEach(sym=>_valBars.delete(sym));}
  }
  const abort = new AbortController(); abort.abort();
  for (const [name, action] of [
    ['warm batches',()=>_fetchBars1yWarm(['SYNTHETIC'],abort.signal)],
    ['exact validation',()=>validateExact([], 'sepa',null,abort.signal)]
  ]) {
    let rejected = false;
    try { await action(); } catch(e) { rejected=e.name==='AbortError'; }
    check(name + ': aborted work stops before starting',rejected);
  }
  const originalGet=_barsStore.get, originalBatch=_fetchBars1yBatch;
  const midAbort=new AbortController(); let calls=0, aborted=false;
  try {
    _barsStore.get=async()=>null;
    _fetchBars1yBatch=async()=>{calls++;midAbort.abort();};
    try { await _fetchBars1yWarm(Array.from({length:180},(_,i)=>'SYNTHETIC-'+i),midAbort.signal); }
    catch(e){aborted=e.name==='AbortError';}
    check('warm batches: cancellation prevents remaining chunks',aborted && calls===1);
  } finally { _barsStore.get=originalGet; _fetchBars1yBatch=originalBatch; }

      const factory=new Function('_scanQuery','_universeBody','return ('+fetchUniverse.toString()+')');
      let failed=false;try{await factory(async body=>{if(body.filter[0].right==='dr')throw Error('offline');return [{s:'SYNTHETIC'}];},_universeBody)();}catch{failed=true;}
      check('incomplete universe fails instead of ranking partial data',failed);
      const merged=await factory(async()=>[{s:'SYNTHETIC'}],_universeBody)();
      check('stock and ADR overlap is deduplicated',merged.length===1);
      check('partial validation is explicitly labelled',_validationNote({validation:{status:'approximate',asOf:null}}).includes('אימות חלקי'));
      check('verified price data includes date',_validationNote({validation:{status:'verified',asOf:1750000000}}).includes('נתוני מחיר עד'));
      check('unknown validation is not advertised as verified',_validationNote({})==='');
      check('screen switching remains outside collapsed criteria',!document.querySelector('.filter-body .screeners')&&!!document.querySelector('.filter-panel > .screeners'));
      const panel=document.querySelector('.filter-panel');panel.classList.add('open');document.querySelector('.advanced-filters').open=true;
      check('expanded criteria have no fixed clipping height',getComputedStyle(document.querySelector('.filter-body')).maxHeight==='none');
      check('login email field has usable height',parseFloat(getComputedStyle(document.querySelector('#authEmail')).minHeight)>=40);

  return checks;
})()
