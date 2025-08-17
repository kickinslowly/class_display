/* Display logic: Three.js shader background + GSAP-enhanced timer overlay + Socket.IO/polling sync */
(function(){
  const cfg = window.APP_CONFIG || { sockets:false, theme:'fire' };
  const elTimer = document.getElementById('timer');
  const elLabel = document.getElementById('label');
  const elEnds  = document.getElementById('ends');
  const glContainer = document.getElementById('gl-container');

  // ---------------------
  // Utility: format seconds as M:SS
  function fmt(sec){
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec/60);
    const s = sec%60;
    const ss = ('0' + s).slice(-2);
    return m + ':' + ss;
  }

  let state = {
    remaining: 0,
    status: 'idle',
    label: 'Idle',
    ends_at: null,
    next_start: null,
    theme: cfg.theme || 'fire',
    lastServerTs: null,
    effectiveThemeIndex: 0,
  };
  
  // Polling guard
  let __pollingStarted = false;
  
  // Theme helpers
  const THEME_INDICES = { fire:0, liquid:1, frost:2, poison:3 };
  function themeNameToIndex(n){
    const key = (n||'').toLowerCase();
    return Object.prototype.hasOwnProperty.call(THEME_INDICES, key) ? THEME_INDICES[key] : -1; // -1 => random
  }
  function pickRandomThemeIndex(prev){
    const choices = [0,1,2,3];
    // prefer different from previous
    if (typeof prev === 'number' && prev>=0 && prev<=3){
      const filtered = choices.filter(i=>i!==prev);
      return filtered[Math.floor(Math.random()*filtered.length)];
    }
    return choices[Math.floor(Math.random()*choices.length)];
  }
  function colorForThemeIndex(i){
    switch(i){
      case 1: return '#d8efff'; // liquid
      case 2: return '#e8f6ff'; // frost
      case 3: return '#d8ffd8'; // poison
      case 0:
      default: return '#ffe1c4'; // fire
    }
  }

  function applyStateVisual(){
    elTimer.textContent = fmt(state.remaining);
    elLabel.textContent = state.label || 'Idle';
    if (state.status === 'pre_session' && state.next_start){
      elEnds.textContent = `Starts ${state.next_start}`;
    } else {
      elEnds.textContent = state.ends_at ? `Ends ${state.ends_at}` : '';
    }

    const critical = state.status === 'in_session' && state.remaining <= 60;
    const warn = state.status === 'in_session' && state.remaining <= 5*60 && state.remaining > 60;

    const base = colorForThemeIndex(state.effectiveThemeIndex || 0);
    const color = critical ? '#ff5555' : warn ? '#ffb020' : base;
    if (typeof window.gsap !== 'undefined' && gsap && typeof gsap.to === 'function') {
      gsap.to(elTimer, { color, duration: 0.4, ease: 'power1.out' });
    } else {
      try { elTimer.style.color = color; } catch(e){}
    }

    if (critical){
      if (typeof window.gsap !== 'undefined' && gsap && typeof gsap.to === 'function') {
        gsap.to('#overlay', { keyframes: [{scale:1.02},{scale:1.0}], repeat:-1, yoyo:true, duration:0.6, ease:'sine.inOut' });
      }
    } else {
      if (typeof window.gsap !== 'undefined' && gsap) {
        if (typeof gsap.killTweensOf === 'function') gsap.killTweensOf('#overlay');
        if (typeof gsap.to === 'function') gsap.to('#overlay', { scale:1, duration:0.2 });
      }
    }
  }

  function updateFromPayload(data){
    if (!data) return;
    const changedTheme = data.theme && data.theme !== state.theme;

    const prevRem = state.remaining;
    const prevStatus = state.status;

    // Be lenient with key naming from server or external push
    const rem = (data.remaining_seconds != null) ? data.remaining_seconds
              : (data.remainingSeconds != null) ? data.remainingSeconds
              : (data.remaining != null) ? data.remaining
              : 0;
    state.remaining = Math.max(0, Number(rem)||0);
    state.status = data.status || 'idle';
    state.label = data.current_label || data.label || (state.status==='in_session' ? 'Class' : 'Idle');
    state.ends_at = data.ends_at || data.endsAt || null;
    state.next_start = data.next_start || data.nextStart || null;
    if (data.theme) state.theme = data.theme;
    state.lastServerTs = data.server_time_iso || data.serverTime || null;

    // session total estimation for progression
    if (state.status === 'in_session'){
      if (!state.sessionTotal || state.remaining > state.sessionTotal){
        state.sessionTotal = state.remaining;
      }
    } else {
      // reset flags when leaving session
      state.sessionTotal = state.sessionTotal || null;
      state._finaleDone = false;
    }

    if (changedTheme){
      switchTheme(state.theme);
    }

    // Apply visuals without driving any simulation reactions
    applyStateVisual();
  }

  // ---------------------
  // Networking: socket or polling
  async function fetchNow(){
    try{
      if (typeof window.fetch === 'function'){
        const res = await fetch('/now', { cache: 'no-store' });
        if (res.ok){
          const data = await res.json();
          updateFromPayload(data);
          return;
        }
      }
      // Fallback for older browsers: XMLHttpRequest
      await new Promise((resolve)=>{
        try{
          const xhr = new XMLHttpRequest();
          xhr.open('GET', '/now', true);
          xhr.setRequestHeader('Cache-Control', 'no-store');
          xhr.onreadystatechange = function(){
            if (xhr.readyState === 4){
              try{
                if (xhr.status >= 200 && xhr.status < 300){
                  const data = JSON.parse(xhr.responseText||'{}');
                  updateFromPayload(data);
                }
              }catch(e){}
              resolve();
            }
          };
          xhr.onerror = function(){ resolve(); };
          xhr.send();
        } catch(e){ resolve(); }
      });
    }catch(e){ /* ignore */ }
  }

  function startLocalTick(){
    if (window.__tickStarted) return; window.__tickStarted = true;
    setInterval(()=>{
      if (state.status === 'in_session' || state.status === 'pre_session'){
        if (state.remaining > 0){
          state.remaining -= 1;
          // Decouple visuals from simulations: no callbacks on second change
          applyStateVisual();
        }
      }
    }, 1000);
  }

  function startPolling(){
    if (__pollingStarted) return; __pollingStarted = true;
    // Fetch now immediately, then every 10 seconds to resync
    fetchNow();
    setInterval(fetchNow, 10000);
    startLocalTick();
  }

  function startSSE(){
    if (!('EventSource' in window)) { startPolling(); return; }
    try {
      const es = new EventSource('/events');
      es.onmessage = (e)=>{
        try {
          const msg = JSON.parse(e.data);
          const type = msg.event || 'message';
          const data = msg.data || {};
          if (type === 'snapshot') {
            updateFromPayload(data);
          } else if (type === 'config') {
            if (data.theme) { state.theme = data.theme; switchTheme(state.theme); }
            applyStateVisual();
          } else if (type === 'tick') {
            if (typeof data.remainingSeconds === 'number') {
              state.remaining = Math.max(0, data.remainingSeconds);
              applyStateVisual();
            }
          } else {
            updateFromPayload(data);
          }
        } catch(err){}
      };
      es.onerror = ()=>{ startPolling(); };
    } catch(e){
      startPolling();
    }
  }

  // ---------------------
  // Three.js setup
  let renderer, scene, camera, mesh, uniforms;
  let fluidSim = null;

  function initGL(){
    // Liquid fire shader is initialized by liquid_fire.js (creates its own canvas)
    initThemeFromConfig();
  }

  // Legacy no-ops retained to avoid breaking references
  function onResize(){}
  function animate(){}

  function initThemeFromConfig(){
    // Initialize effective theme from initial state.theme (may be 'random')
    switchTheme(state.theme || 'fire');
  }

  function switchTheme(themeName){
    let idx = themeNameToIndex(themeName);
    if (idx === -1) {
      idx = pickRandomThemeIndex(state.effectiveThemeIndex);
    }
    state.effectiveThemeIndex = idx;
    if (uniforms && uniforms.uTheme) {
      uniforms.uTheme.value = idx; // set immediately for clean switch
    }
    // Set digit color for the base (warnings override in applyStateVisual)
    const color = colorForThemeIndex(idx);
    if (typeof window.gsap !== 'undefined' && gsap && typeof gsap.to === 'function') {
      gsap.to(elTimer, { color, duration: 0.4, ease: 'power1.out' });
    } else {
      try { elTimer.style.color = color; } catch(e){}
    }
  }

  // ---------------------
  // Fluid color & splat helpers
  function clamp01(x){ return Math.max(0, Math.min(1, x)); }
  function lerp(a,b,t){ return a + (b-a)*t; }
  function lerp3(a,b,t){ return [ lerp(a[0],b[0],t), lerp(a[1],b[1],t), lerp(a[2],b[2],t) ]; }
  function brighten(c, f){ return [ clamp01(c[0]*f), clamp01(c[1]*f), clamp01(c[2]*f) ]; }
  function mix(a,b,t){ return [ lerp(a[0],b[0],t), lerp(a[1],b[1],t), lerp(a[2],b[2],t) ]; }
  function randInt(min,max){ return Math.floor(min + Math.random()*(max-min+1)); }

  function progressionColor(remaining){
    const total = Math.max(1, state.sessionTotal || remaining || 1);
    const t = clamp01(1 - remaining / total); // 0 start -> 1 end
    if (t < 0.34){
      const u = t/0.34;
      const c1 = [0.02, 0.55, 0.85]; // cyan-blue
      const c2 = [0.00, 0.80, 0.95]; // bright cyan
      return lerp3(c1, c2, u);
    } else if (t < 0.67){
      const u = (t-0.34)/0.33;
      const c1 = [0.48, 0.36, 0.82]; // purple
      const c2 = [1.00, 0.55, 0.12]; // orange
      return lerp3(c1, c2, u);
    } else {
      const u = (t-0.67)/0.33;
      const c1 = [1.00, 0.43, 0.00]; // ember orange
      const c2 = [1.00, 0.07, 0.15]; // fiery red
      return lerp3(c1, c2, u);
    }
  }

  function splatSmall(color){
    if (!fluidSim) return;
    fluidSim.splatRandom(randInt(1,3), { color, forceScale: 0.8, minRadius: 0.012, maxRadius: 0.04, maxForce: 2.0 });
  }
  function splatStrong(color){
    if (!fluidSim) return;
    fluidSim.splatRandom(randInt(3,6), { color: brighten(color,1.35), forceScale: 1.8, minRadius: 0.02, maxRadius: 0.06, maxForce: 3.2 });
  }
  function splatMinute(color){
    if (!fluidSim) return;
    fluidSim.splatRandom(randInt(14,20), { color: brighten(color,1.5), forceScale: 2.4, minRadius: 0.025, maxRadius: 0.08, maxForce: 3.8 });
  }

  function seedAmbient(){
    if (!fluidSim) return;
    const firePalette = [ [1.00,0.38,0.00], [1.00,0.62,0.10], [0.95,0.18,0.12], [0.75,0.20,0.05] ];
    const coolPalette = [ [0.02,0.35,0.70], [0.00,0.55,0.85], [0.15,0.20,0.45] ];
    const pal = state.effectiveThemeIndex===0 ? firePalette : coolPalette;
    const n = 24;
    for(let i=0;i<n;i++){
      const c = pal[Math.floor(Math.random()*pal.length)];
      fluidSim.splatRandom(1, { color: brighten(c, 0.8 + Math.random()*0.6), forceScale: 0.4 + Math.random()*0.6, minRadius: 0.02, maxRadius: 0.06, maxForce: 2.0 });
    }
  }

  function handleSecondChange(remaining){
    try {
      if (typeof window.onNumberChange === 'function') {
        window.onNumberChange(remaining);
      }
    } catch(e) {}
  }

  function finaleBurstOnce(){
    if (state._finaleDone) return;
    state._finaleDone = true;
    try {
      if (typeof window.onFinaleBurst === 'function') {
        window.onFinaleBurst();
      }
    } catch(e) {}
  }

  // Provide a setter for total seconds used by some themes/progress effects
  if (typeof window.setTotalSeconds !== 'function') {
    window.setTotalSeconds = function(total){
      try {
        if (typeof window.onTotalSeconds === 'function') {
          window.onTotalSeconds(total);
        }
      } catch(e) {}
    };
  }

  // Kick off once DOM is ready: init visuals, apply initial state, then start SSE/polling
  document.addEventListener('DOMContentLoaded', function(){
    try { initGL(); } catch(e) {}
    try { applyStateVisual(); } catch(e) {}
    try { startSSE(); } catch(e) { try { startPolling(); } catch(_) {} }
    try { startLocalTick(); } catch(e) {}
    try { fetchNow(); } catch(e) {}
  });
})();
