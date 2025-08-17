/* Fire Embers Background
   Canvas 2D particle system: glowing embers float upward with drift and flicker.
   Hooks:
     - window.onNumberChange(remaining) to spawn intensity bursts
     - window.setTotalSeconds(total) to scale urgency
*/
(function(){
  const container = document.getElementById('gl-container');
  if (!container) return;

  // Clean up any previous canvas with same id
  const prev = document.getElementById('fire-embers-bg');
  if (prev && prev.parentNode) prev.parentNode.removeChild(prev);

  const canvas = document.createElement('canvas');
  canvas.id = 'fire-embers-bg';
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
    if (canvas.width !== w || canvas.height !== h){
      canvas.width = w; canvas.height = h; W=w; H=h;
    }
  }
  window.addEventListener('resize', resize); resize();

  function rnd(a,b){ return a + Math.random()*(b-a); }
  function pick(arr){ return arr[(Math.random()*arr.length)|0]; }

  // Palette and glow settings
  const emberColors = [
    [255, 120,  20], // orange
    [255, 170,  40], // amber
    [255,  70,  30], // red-orange
    [255, 210, 120], // pale
  ];

  const MAX = 240; // particle pool size
  const embers = new Array(MAX).fill(null).map(()=>({
    x: 0, y: 0, vx: 0, vy: 0, r: 0, life: 0, maxLife: 0, c: [255,140,40]
  }));
  let alive = 0;

  function spawn(n, power){
    for(let i=0;i<n;i++){
      const p = embers[alive % MAX];
      const nx = rnd(0.2, 0.8) * W;
      const ny = rnd(0.55, 0.95) * H; // spawn lower half
      const speed = rnd(0.25, 0.9) * (1+power*0.6);
      p.x = nx; p.y = ny;
      p.vx = rnd(-0.18, 0.18) * speed;
      p.vy = rnd(-0.65, -0.25) * speed;
      p.r = rnd(1.5, 3.5) * dpr * (1+power*0.3);
      p.maxLife = rnd(1.6, 3.8);
      p.life = p.maxLife;
      p.c = pick(emberColors);
      alive++;
    }
  }

  // ambient seeds
  spawn(120, 0);

  let urgency = 0; // 0..1
  let totalSeconds = 60*60;
  window.setTotalSeconds = function(t){ if (t>0) totalSeconds=t; };
  window.onNumberChange = function(remaining){
    const rem = Math.max(0, Number(remaining||0));
    urgency = Math.min(1, 1 - rem / Math.max(1,totalSeconds));
    const isMinute = (rem>0 && rem%60===0);
    const base = 14 + Math.floor(urgency*20);
    spawn(base + (isMinute?28:0), urgency);
  };

  let lastTs=0; let paused=false;
  document.addEventListener('visibilitychange', ()=>{ paused = document.hidden; });

  function drawGlow(x,y,r,alpha,color){
    const [cr,cg,cb] = color;
    const grd = ctx.createRadialGradient(x,y, r*0.1, x,y, r);
    grd.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha})`);
    grd.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
  }

  function frame(ts){
    if (paused) { requestAnimationFrame(frame); return; }
    const dt = Math.min(0.05, (ts-lastTs)/1000 || 0.016); lastTs=ts;
    resize();
    // backdrop gradient with subtle flicker
    const flick = 10 + Math.floor(Math.sin(ts*0.002)*6 + urgency*18);
    const top = `rgb(${40+flick}, ${22+Math.floor(flick*0.4)}, 12)`;
    const bottom = `rgb(5, 3, 2)`;
    const lg = ctx.createLinearGradient(0,0,0,H);
    lg.addColorStop(0, top); lg.addColorStop(1, bottom);
    ctx.fillStyle = lg; ctx.fillRect(0,0,W,H);

    // subtle heat distortion shimmer lines
    ctx.globalCompositeOperation = 'lighter';
    for(let i=0;i<3;i++){
      const y = (H*0.4 + (i*H*0.15) + (ts*0.04 + i*77)%H*0.04)|0;
      ctx.globalAlpha = 0.025 + urgency*0.02;
      ctx.fillStyle = `rgba(255,160,60,1)`;
      ctx.fillRect(0,y, W, 1.5*dpr);
    }

    // update and draw embers
    for(let i=0;i<Math.min(alive,MAX);i++){
      const p = embers[i];
      if (p.life<=0){ continue; }
      // drift and buoyancy
      p.vx += (Math.random()-0.5)*0.03;
      p.vy -= 0.01;
      p.x += p.vx;
      p.y += p.vy;
      p.life -= dt;
      // wrap/spawn anew if off-screen or dead
      if (p.y < -20 || p.x < -20 || p.x > W+20 || p.life<=0){
        p.life = 0; continue;
      }
      // glow
      const lifeT = Math.max(0, p.life / p.maxLife);
      const alpha = 0.08 + 0.22*lifeT;
      const r = p.r * (0.8 + 0.6*Math.sin(ts*0.02 + p.x*0.01));
      drawGlow(p.x, p.y, r, alpha, p.c);
    }

    ctx.globalAlpha = 1; ctx.globalCompositeOperation='source-over';
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
