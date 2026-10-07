(async()=>{const modal=(()=>{
      document.documentElement.dataset.theme='tj-light';
      const trigger=document.querySelector('.screener-btn');trigger.focus();
      openChart('NASDAQ:SYNTHETIC','SYNTHETIC','Synthetic fixture');
      const frame=document.querySelector('#modalChart iframe');
      const checks=[{name:'light chart modal follows theme',pass:frame.srcdoc.includes('"theme":"light"')},{name:'chart iframe has accessible title',pass:!!frame.title},{name:'modal receives keyboard focus',pass:document.activeElement?.closest('#modal')!==null}];
      closeModal();checks.push({name:'modal restores original keyboard focus',pass:document.activeElement===trigger});
      document.documentElement.removeAttribute('data-theme');return checks;
})();const matrix=await (async()=>{
      const rows=Array.from({length:36},(_,i)=>({ticker:'SYNTH'+i,sym:'NASDAQ:SYNTH'+i,name:'Synthetic company '+i,close:100+i,rs:90,fromHighPct:-5,fromLowPct:50,perfY:60,perf3:30,perf6:40,eps:25,rev:20,roe:18,nm:15,earnIn:30,mc:2e9,sector:'Technology',ttPass:i%2===0,checks:{},validation:{status:'verified',asOf:1750000000}}));
      _currentUser={id:'synthetic-desktop'};watchlist=new Set(rows.map(r=>r.ticker));ttUniverse=Object.fromEntries(rows.map(r=>[r.ticker,r]));
      const checks=[];
      for(const theme of ['tj','tj-light'])for(const key of Object.keys(SCREENERS))for(const tab of ['screen','watch'])for(const view of ['table','gallery']){
        document.documentElement.dataset.theme=theme;setScreener(key);allResults=rows;results=rows;mode=tab;layout=view;render();
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const target=document.querySelector(view==='table'?'#tableView':'#galleryView');
        checks.push({name:[theme,key,tab,view].join('/'),pass:!!target&&target.textContent.length>0&&document.documentElement.scrollWidth<=innerWidth+1});
      }
      return checks;
})();const fund=document.querySelector('#useFund');fund.checked=false;toggleFundFields();const disabled=[...document.querySelectorAll('#fundFields input')].every(el=>el.disabled);fund.checked=true;toggleFundFields();const enabled=[...document.querySelectorAll('#fundFields input')].every(el=>!el.disabled);return [...modal,...matrix,{name:'inactive fundamental fields are disabled for keyboard',pass:disabled},{name:'fundamental fields re-enable correctly',pass:enabled}];})()