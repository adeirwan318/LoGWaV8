﻿// START patched app.js — fixes slider input, live margin label, and mode events
(function(){
  const $ = s => document.querySelector(s);
  const slider = $('input[type="range"]') || $('#margin');
  const marginLabel = document.querySelector('label[for="margin"]') || document.querySelector('.margin-label') || (()=>{
    const d = document.createElement('div'); d.className='margin-label'; d.style.display='block'; d.style.marginBottom='6px'; if(slider && slider.parentNode) slider.parentNode.insertBefore(d, slider); return d;
  })();
  const levEl = document.querySelector('select[name*="leverage" i], input[name*="leverage" i]') || document.querySelector('input[type="number"]');
  const modeEl = document.querySelector('#mode') || Array.from(document.querySelectorAll('select')).find(s=>/mode/i.test(s.id||s.name||s.className)) || null;
  const startBtn = document.querySelector('#start') || Array.from(document.querySelectorAll('button')).find(b=>/start auto/i.test(b.innerText||b.value||''));
  // quick element fallback for price/equity/position if page uses different selectors
  const priceEl = $('#price') || document.querySelector('.price') || (()=>{
    const n=document.createElement('div'); n.id='price'; n.style.display='none'; document.body.appendChild(n); return n;
  })();
  const equityEl = $('#equity') || document.querySelector('.equity') || (()=>{
    const n=document.createElement('div'); n.id='equity'; n.style.display='none'; document.body.appendChild(n); return n;
  })();

  // WS connect
  function connectWS(){
    try{
      if(window.__LOGWA_WS__ && window.__LOGWA_WS__.readyState === WebSocket.OPEN) return;
      const proto = (location.protocol==='https:') ? 'wss://' : 'ws://';
      const url = proto + location.host;
      window.__LOGWA_WS__ = new WebSocket(url);
      window.__LOGWA_WS__.onopen = ()=> console.log('[app] ws open');
      window.__LOGWA_WS__.onmessage = ev => {
        try{ const d = JSON.parse(ev.data);
          if(d.type === 'price'){ if(typeof d.price !== 'undefined') priceEl.textContent = Number(d.price).toLocaleString(); if(typeof d.equity !== 'undefined') equityEl.textContent = Number(d.equity).toLocaleString(); }
          else if(d.type === 'init' || d.type === 'ok'){ if(d.state){ if(typeof d.state.initialMarginPct !== 'undefined'){ if(slider) slider.value = d.state.initialMarginPct; marginLabel.textContent = 'Initial Margin: ' + d.state.initialMarginPct + '%'; } if(typeof d.state.leverage !== 'undefined' && levEl) levEl.value = d.state.leverage; if(typeof d.price !== 'undefined') priceEl.textContent = Number(d.price).toLocaleString(); if(typeof d.equity !== 'undefined') equityEl.textContent = Number(d.equity).toLocaleString(); } }
          else if(d.type === 'equity' && typeof d.equity !== 'undefined'){ equityEl.textContent = Number(d.equity).toLocaleString(); }
        }catch(e){ /* ignore parse errors */ }
      };
      window.__LOGWA_WS__.onclose = ()=>{ console.warn('[app] ws closed - reconnect'); setTimeout(connectWS,1500); };
      window.__LOGWA_WS__.onerror = e => console.warn('[app] ws error', e);
    }catch(e){ console.warn('[app] connectWS err', e); }
  }

  function sendWS(obj){
    try{
      if(window.__LOGWA_WS__ && window.__LOGWA_WS__.readyState === WebSocket.OPEN){
        window.__LOGWA_WS__.send(JSON.stringify(obj));
      } else {
        // fallback: try REST for safe ops if WS not ready
        if(obj.type === 'setMargin'){
          fetch('/api/computeQtyTest?marginPct=' + encodeURIComponent(obj.pct)).catch(()=>{});
        } else if(obj.type === 'setLeverage'){
          // no-op fallback; server will pick up on next /api/position call
        } else if(obj.type === 'setMode'){
          // no-op fallback
        }
      }
    }catch(e){ console.warn('[app] sendWS err', e); }
  }

  // attach UI listeners safely (idempotent)
  function attachListeners(){
    // slider: live input + commit on change
    if(slider){
      slider._onInput = function(){ marginLabel.textContent = 'Initial Margin: ' + slider.value + '%'; };
      slider._onChange = function(){ const pct = Number(slider.value||0); marginLabel.textContent = 'Initial Margin: ' + pct + '%'; sendWS({ type:'setMargin', pct }); };
      slider.removeEventListener('input', slider._onInput); slider.removeEventListener('change', slider._onChange);
      slider.addEventListener('input', slider._onInput);
      slider.addEventListener('change', slider._onChange);
    }

    // leverage
    if(levEl){
      levEl._onChange = function(){ const v = Number(levEl.value||1); sendWS({ type:'setLeverage', leverage: v }); };
      levEl.removeEventListener('change', levEl._onChange); levEl.addEventListener('change', levEl._onChange);
    }

    // mode (send setMode on change)
    if(modeEl){
      modeEl._onMode = function(){ const m = (modeEl.value||modeEl.innerText||'auto').toString().toLowerCase(); console.log('[app] mode ->', m); marginLabel.textContent = (marginLabel.textContent||'Initial Margin:') ; sendWS({ type:'setMode', mode: m }); };
      modeEl.removeEventListener('change', modeEl._onMode); modeEl.addEventListener('change', modeEl._onMode);
    }

    // start button
    if(startBtn){
      startBtn._onClick = async function(){
        console.log('[app] START clicked -> /api/auto/start');
        try{ const r = await fetch('/api/auto/start',{ method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mode: (modeEl?modeEl.value:'real'), symbol:'BTCUSDT' }) }); const j = await r.json().catch(()=>null); console.log('[app] start resp', r.status, j); }catch(e){ console.error('[app] start err', e); }
      };
      startBtn.removeEventListener('click', startBtn._onClick); startBtn.addEventListener('click', startBtn._onClick);
    }
  }

  // initial population until WS init arrives
  async function initialPopulate(){
    try{
      const p = await fetch('/api/price').then(r=>r.json().catch(()=>null)).catch(()=>null);
      if(p && p.ok && typeof p.price !== 'undefined'){ priceEl.textContent = Number(p.price).toLocaleString(); if(p.equity) equityEl.textContent = Number(p.equity).toLocaleString(); }
      const pos = await fetch('/api/position?symbol=BTCUSDT').then(r=>r.json().catch(()=>null)).catch(()=>null);
      if(pos && pos.ok && Array.isArray(pos.data) && pos.data.length){ const s = pos.data[0]; if(levEl) levEl.value = s.leverage || levEl.value; if(s.markPrice) priceEl.textContent = Number(s.markPrice).toLocaleString(); }
    }catch(e){}
  }

  // bootstrap
  connectWS();
  attachListeners();
  initialPopulate();
  window.__APP_FRONTEND__ = { connectWS, attachListeners, initialPopulate };
  console.log('[app] patched frontend loaded');
})();
/* SLIDER HOTFIX — persistent: bind margin slider to ws with debounce + UI feedback */
(function(){
  console.log('[SLIDER HOTFIX] init (persisted)');
  let fb = document.getElementById('__slider_feedback__');
  if(!fb){
    fb = document.createElement('div');
    fb.id = '__slider_feedback__';
    fb.style.position = 'fixed';
    fb.style.right = '18px';
    fb.style.top = '18px';
    fb.style.padding = '8px 12px';
    fb.style.background = 'rgba(0,0,0,0.7)';
    fb.style.color = 'white';
    fb.style.borderRadius = '8px';
    fb.style.zIndex = 99999;
    fb.style.fontFamily = 'monospace';
    fb.style.fontSize = '13px';
    fb.style.pointerEvents = 'none';
    fb.textContent = 'slider: —';
    document.body.appendChild(fb);
  }
  function toast(msg){
    try{
      const t = document.createElement('div');
      t.textContent = msg;
      t.style.position='fixed';
      t.style.left='50%';
      t.style.transform='translateX(-50%)';
      t.style.bottom='24px';
      t.style.background='rgba(0,0,0,0.8)';
      t.style.color='white';
      t.style.padding='8px 12px';
      t.style.borderRadius='8px';
      t.style.zIndex=99999;
      t.style.fontFamily='monospace';
      document.body.appendChild(t);
      setTimeout(()=> t.remove(), 1600);
    }catch(e){ console.warn('toast err', e); }
  }
  function debounce(fn, wait){
    let t;
    return function(...a){
      clearTimeout(t);
      t = setTimeout(()=>fn.apply(this,a), wait);
    };
  }
  function sendToServer(obj){
    try{
      if(window.__LOGWA_WS__ && window.__LOGWA_WS__.readyState===1){
        window.__LOGWA_WS__.send(JSON.stringify(obj));
        return 'ws';
      }
      if(window.ws && window.ws.readyState===1){
        window.ws.send(JSON.stringify(obj));
        return 'ws_fallback';
      }
      if(window.socket && typeof window.socket.emit==='function'){
        window.socket.emit('setMargin', obj);
        return 'socket';
      }
    }catch(e){ console.error('[SLIDER HOTFIX] send err', e); }
    return null;
  }
  function findSlider(){
    let s = document.getElementById('margin');
    if(s) return s;
    s = document.querySelector('input[type=\"range\"]');
    if(s) return s;
    s = Array.from(document.querySelectorAll('div,span,input')).find(el => /(margin|pct|initial)/i.test(el.id||el.name||el.className||el.innerText||''));
    return s || null;
  }
  function bindSliderOnce(){
    const el = findSlider();
    if(!el) return false;
    if(el._sliderHotfixBound) return true;
    el._sliderHotfixBound = true;
    const liveLabel = (v) => {
      fb.textContent = 'slider: ' + v + '%';
      fb.style.opacity = '1';
      setTimeout(()=> fb.style.opacity = '0.9', 50);
    };
    const emit = debounce((val) => {
      const pct = Number(val);
      const who = sendToServer({ type: 'setMargin', pct });
      console.log('[SLIDER HOTFIX] EMIT setMargin', pct, 'via', who);
      toast('setMargin → ' + pct + (who ? ' ('+who+')' : ' (no-ws)'));
    }, 180);
    const handler = (e) => {
      const v = e.target ? e.target.value : e;
      console.log('[SLIDER HOTFIX] live', v);
      liveLabel(v);
      emit(v);
    };
    try{
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    }catch(e){
      console.warn('[SLIDER HOTFIX] addEvent err', e);
    }
    console.log('[SLIDER HOTFIX] bound to element', el);
    return true;
  }
  if(!window.__SLIDER_HOTFIX_MO__){
    const mo = new MutationObserver(()=>{
      bindSliderOnce();
    });
    mo.observe(document.body, { childList:true, subtree:true });
    window.__SLIDER_HOTFIX_MO__ = mo;
    console.log('[SLIDER HOTFIX] MO started');
  }
  if(!bindSliderOnce()){
    console.warn('[SLIDER HOTFIX] slider not found immediately — MO will wait for it');
    toast('slider bind waiting...');
  } else {
    toast('slider bound');
  }
})();
