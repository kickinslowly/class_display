/* Poison Gas Background
   Canvas 2D: swirling semi-transparent green gas puffs driven by a simple flow field.
   Hooks:
     - window.onNumberChange(remaining) to intensify swirls
     - window.setTotalSeconds(total)
*/
(function(){
  const container = document.getElementById('gl-container');
  if (!container) return;

  const old = document.getElementById('poison-gas-bg');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  const canvas = document.createElement('canvas');
  canvas.id = 'poison-gas-bg';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.style.zIndex = '0';
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let dpr = Math.min(window.devicePixelRatio||1, 2);
  let W=0,H=0;
  function resize(){
    dpr = Math.min(window.devicePixelRatio||1, 2);
    const w = Math.max(1, Math.floor(container.clientWidth * dpr));
    const h = Math.max(1, Math.floor(container.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h){ canvas.width=w; canvas.height=h; W=w; H=h; }
  }
  window.addEventListener('resize', resize); resize();

  // Flow field utility (simple curl-noise-like using sin/cos)
  function flowAt(x,y,t){
    const s = 0.0009; // scale
    const a = Math.sin((x+y)*s + t*0.15);
    const b = Math.cos((x-y)*s*1.15 - t*0.12);
    const u = Math.sin(y*s*0.7 + a*1.3 + t*0.08);
    const v = Math.cos(x*s*0.8 + b*1.1 - t*0.06);
    return { x: u, y: v };
  }

  function rnd(a,b){ return a + Math.random()*(b-a); }

  const MAX = 180;
  const puffs = new Array(MAX).fill(0).map(()=>({x:0,y:0, r:0, alpha:0, hue:120, life:0, maxLife:1, seed:Math.random()*1000}));
  let idx=0; let urgency=0; let totalSeconds=60*60; let lastTs=0; let paused=false;
  document.addEventListener('visibilitychange', ()=>{ paused=document.hidden; });

  function spawn(n, strong){
    for(let i=0;i<n;i++){
      const p = puffs[idx++ % MAX];
      // Spawn across screen with bias from bottom and sides
      const edge = Math.random();
      if (edge < 0.33){ p.x = rnd(0.05*W, 0.95*W); p.y = H + rnd(0, 0.1*H); }
      else if (edge < 0.66){ p.x = -rnd(0, 0.08*W); p.y = rnd(0.15*H, 0.9*H); }
      else { p.x = W + rnd(0, 0.08*W); p.y = rnd(0.15*H, 0.9*H); }
      p.r = rnd(30, 120) * dpr * (strong?1.2:1);
      p.alpha = rnd(0.06, 0.16) + urgency*0.05;
      p.hue = 110 + Math.floor(Math.random()*30); // green range
      p.life = 0; p.maxLife = rnd(3.5, 8.0);
      p.seed = Math.random()*1000;
    }
  }

  // Ambient seeding
  spawn(90, false);

  window.setTotalSeconds = function(t){ if (t>0) totalSeconds=t; };
  window.onNumberChange = function(remaining){
    const rem = Math.max(0, Number(remaining||0));
    urgency = Math.min(1, 1 - rem / Math.max(1,totalSeconds));
    const isMinute = (rem>0 && rem%60===0);
    const base = 8 + Math.floor(urgency*18);
    spawn(base + (isMinute?24:0), isMinute);
  };

  function drawPuff(p){
    const grd = ctx.createRadialGradient(p.x,p.y, p.r*0.05, p.x,p.y, p.r);
    const col1 = `hsla(${p.hue}, 70%, ${40+Math.floor(urgency*20)}%, ${p.alpha})`;
    const col2 = `hsla(${p.hue}, 70%, 20%, 0)`;
    grd.addColorStop(0, col1);
    grd.addColorStop(1, col2);
    ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fill();
  }

  function frame(ts){
    if (paused){ requestAnimationFrame(frame); return; }
    const t = (ts||performance.now())/1000; const dt = Math.min(0.05, (ts-lastTs)/1000 || 0.016); lastTs=ts;
    resize();
    // background cool dark greenish gradient
    const g = ctx.createLinearGradient(0,0,0,H);
    g.addColorStop(0, 'rgb(3,12,6)');
    g.addColorStop(1, 'rgb(2,5,3)');
    ctx.fillStyle = g; ctx.fillRect(0,0,W,H);

    ctx.globalCompositeOperation = 'lighter';
    for(let i=0;i<MAX;i++){
      const p = puffs[i];
      p.life += dt; if (p.life>p.maxLife){ continue; }
      const lifeT = p.life/p.maxLife;
      const flow = flowAt(p.x + Math.sin(p.seed+t)*40, p.y + Math.cos(p.seed-t)*40, t);
      const speed = 16 + urgency*38;
      p.x += flow.x * speed * dt;
      p.y += -(0.5 + urgency*0.8) * speed * 0.25 * dt + flow.y * speed * 0.25 * dt;
      p.alpha *= 0.999;
      drawPuff(p);
    }
    ctx.globalCompositeOperation = 'source-over';

    // light fog overlay to soften
    ctx.globalAlpha = 0.08 + urgency*0.04;
    ctx.fillStyle = '#08330d';
    ctx.fillRect(0,0,W,H);
    ctx.globalAlpha = 1;

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
