/* Fluid Theme Wrapper: initializes WebGL fluid simulation and hooks into countdown events.
   Inspired by Pavel Dobryakov's WebGL fluid, adapted for a vivid classroom timer backdrop.
   This script:
   - Ensures initFluid is available (loads js/fluid.js on-demand if needed)
   - Creates a full-screen canvas in #gl-container
   - Seeds ambient colorful dye against a black background
   - Reacts to countdown ticks via window.onNumberChange and finale via window.onFinaleBurst
*/
(function(){
  const container = document.getElementById('gl-container');
  if (!container) return;

  // State for palette progression
  let totalSeconds = 70*60; // default; can be overridden via setTotalSeconds
  let sim = null;

  // Utility color helpers
  function clamp01(x){ return Math.max(0, Math.min(1, x)); }
  function lerp(a,b,t){ return a + (b-a)*t; }
  function lerp3(a,b,t){ return [ lerp(a[0],b[0],t), lerp(a[1],b[1],t), lerp(a[2],b[2],t) ]; }
  function brighten(c, f){ return [ clamp01(c[0]*f), clamp01(c[1]*f), clamp01(c[2]*f) ]; }
  function mix(a,b,t){ return [ lerp(a[0],b[0],t), lerp(a[1],b[1],t), lerp(a[2],b[2],t) ]; }
  function randInt(min,max){ return Math.floor(min + Math.random()*(max-min+1)); }

  // Palette inspired by fluid neon—cool cyan -> purple -> warm ember
  function progressionColor(remaining){
    const total = Math.max(1, totalSeconds||1);
    const t = clamp01(1 - Math.max(0, Number(remaining||0)) / total);
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

  function seedAmbient(){
    if (!sim) return;
    const cools = [[0.02,0.35,0.70],[0.00,0.55,0.85],[0.15,0.20,0.45]];
    const warms = [[1.00,0.38,0.00],[1.00,0.62,0.10],[0.95,0.18,0.12]];
    const pal = Math.random()<0.5 ? cools : warms;
    const n = 28;
    for(let i=0;i<n;i++){
      const c = pal[Math.floor(Math.random()*pal.length)];
      sim.splatRandom(1, { color: brighten(c, 0.9 + Math.random()*0.7), forceScale: 0.35 + Math.random()*0.85, minRadius: 0.02, maxRadius: 0.07, maxForce: 2.4 });
    }
  }

  function splatSmall(color){ if (sim) sim.splatRandom(randInt(1,3), { color, forceScale: 0.9, minRadius: 0.012, maxRadius: 0.045, maxForce: 2.2 }); }
  function splatStrong(color){ if (sim) sim.splatRandom(randInt(4,7), { color: brighten(color,1.4), forceScale: 1.9, minRadius: 0.022, maxRadius: 0.075, maxForce: 3.4 }); }
  function splatMinute(color){ if (sim) sim.splatRandom(randInt(16,22), { color: brighten(color,1.55), forceScale: 2.5, minRadius: 0.03, maxRadius: 0.09, maxForce: 4.0 }); }

  function hookInteractions(){
    if (!sim) return;
    // Optional: pointer moves add gentle swirls
    let lastX = 0.5, lastY = 0.5;
    container.addEventListener('pointermove', (e)=>{
      const rect = container.getBoundingClientRect();
      const x = (e.clientX - rect.left)/rect.width;
      const y = 1 - (e.clientY - rect.top)/rect.height;
      const dx = (x - lastX), dy = (y - lastY);
      lastX = x; lastY = y;
      sim.splat(x,y, [0.7*Math.random(),0.7*Math.random(),1.0*Math.random()], 0.03, [dx*8, dy*8]);
    });
  }

  function installHooks(){
    // Adopt the countdown hooks used by display.js (do not change timer logic)
    window.setTotalSeconds = function(total){ if (typeof total === 'number' && total > 0) totalSeconds = total; };
    window.onNumberChange = function(remaining){
      const rem = Math.max(0, Number(remaining||0));
      const isMinute = rem>0 && (rem % 60 === 0);
      const col = progressionColor(rem);
      if (isMinute) {
        splatMinute(col);
      } else if (rem % 10 === 0) {
        splatStrong(col);
      } else {
        splatSmall(col);
      }
    };
    window.onFinaleBurst = function(){
      // Big celebration splash with multi-hue burst
      const hues = [ [1.00,0.50,0.10], [0.95,0.20,0.15], [0.10,0.65,1.00], [0.60,0.30,1.00], [0.20,1.00,0.60] ];
      for(let i=0;i<5;i++){
        const c = hues[i%hues.length];
        sim.splatRandom(18, { color: brighten(c, 1.4), forceScale: 2.8, minRadius: 0.035, maxRadius: 0.10, maxForce: 4.5 });
      }
    };
  }

  function begin(){
    try {
      sim = window.initFluid(container, { maxDPR: 2 });
      seedAmbient();
      hookInteractions();
      installHooks();
      // Handle container resizes
      window.addEventListener('resize', function(){ try{ sim && sim.resize(); }catch(e){} });
    } catch(e) {
      console.warn('[fluid-theme] init failed:', e);
    }
  }

  function ensureAndStart(){
    if (typeof window.initFluid === 'function') { begin(); return; }
    // Load the core fluid engine then start
    const s = document.createElement('script');
    s.src = (window.__FLUID_CORE_PATH__) || (document.body.getAttribute('data-fluid-core') || '/static/js/fluid.js');
    s.onload = begin;
    s.onerror = function(){ console.warn('[fluid-theme] failed to load fluid core'); };
    document.head.appendChild(s);
  }

  ensureAndStart();
})();
