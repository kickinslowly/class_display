/* Frost & Ice Background
   Canvas 2D: softly falling snow crystals with frosty haze and occasional sparkle bursts.
   Hooks:
     - window.onNumberChange(remaining) to spawn flakes/sparkles by urgency
     - window.setTotalSeconds(total)
*/
(function(){
  const container = document.getElementById('gl-container');
  if (!container) return;

  const prev = document.getElementById('frost-ice-bg');
  if (prev && prev.parentNode) prev.parentNode.removeChild(prev);

  const canvas = document.createElement('canvas');
  canvas.id = 'frost-ice-bg';
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

  function rnd(a,b){ return a + Math.random()*(b-a); }

  // Snowflakes
  const MAX_FLAKES = 260;
  const flakes = new Array(MAX_FLAKES).fill(0).map(()=>({x:0,y:0,vx:0,vy:0,r:0,spin:0,ang:0,life:0,maxLife:1}));
  let fidx=0;

  // Sparkles (tiny icy twinkles)
  const MAX_SPARK = 120;
  const sparks = new Array(MAX_SPARK).fill(0).map(()=>({x:0,y:0,r:0,a:0,life:0,maxLife:1}));
  let sidx=0;

  let urgency=0; let totalSeconds=60*60; let lastTs=0; let paused=false;
  document.addEventListener('visibilitychange', ()=>{ paused=document.hidden; });

  function spawnFlakes(n, strong){
    for(let i=0;i<n;i++){
      const p = flakes[fidx++ % MAX_FLAKES];
      p.x = rnd(0, W);
      p.y = -rnd(0, 0.2*H);
      const fall = rnd(14, 36) * (1 + (strong?0.2:0));
      p.vx = rnd(-6, 6);
      p.vy = fall;
      p.r = rnd(0.6, 2.2) * dpr * (1 + urgency*0.3);
      p.spin = rnd(-1, 1) * 0.8;
      p.ang = rnd(0, Math.PI*2);
      p.life = 0; p.maxLife = rnd(3, 9);
    }
  }

  function spawnSparkles(n){
    for(let i=0;i<n;i++){
      const sp = sparks[sidx++ % MAX_SPARK];
      sp.x = rnd(0.05*W, 0.95*W);
      sp.y = rnd(0.05*H, 0.55*H);
      sp.r = rnd(0.6, 2.0) * dpr;
      sp.a = 0.3 + Math.random()*0.4;
      sp.life = 0; sp.maxLife = rnd(0.6, 1.6);
    }
  }

  // Ambient
  spawnFlakes(140, false);
  spawnSparkles(40);

  window.setTotalSeconds = function(t){ if (t>0) totalSeconds=t; };
  window.onNumberChange = function(remaining){
    const rem = Math.max(0, Number(remaining||0));
    urgency = Math.min(1, 1 - rem / Math.max(1,totalSeconds));
    const isMinute = (rem>0 && rem%60===0);
    const base = 18 + Math.floor(urgency*26);
    spawnFlakes(base + (isMinute?32:0), isMinute);
    if (isMinute) spawnSparkles(40);
  };

  function drawFlake(p, t){
    // simple star-like flake using small cross
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.ang);
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = 'rgba(220,240,255,0.85)';
    ctx.lineWidth = Math.max(0.6, p.r*0.5);
    ctx.beginPath();
    ctx.moveTo(-3*p.r, 0); ctx.lineTo(3*p.r, 0);
    ctx.moveTo(0, -3*p.r); ctx.lineTo(0, 3*p.r);
    ctx.moveTo(-2*p.r, -2*p.r); ctx.lineTo(2*p.r, 2*p.r);
    ctx.moveTo(2*p.r, -2*p.r); ctx.lineTo(-2*p.r, 2*p.r);
    ctx.stroke();
    ctx.restore();
  }

  function drawSparkle(s){
    ctx.globalAlpha = s.a * (1 - s.life/s.maxLife);
    const grd = ctx.createRadialGradient(s.x,s.y, 0.2*s.r, s.x,s.y, 2.8*s.r);
    grd.addColorStop(0, 'rgba(230,248,255,0.9)');
    grd.addColorStop(1, 'rgba(230,248,255,0.0)');
    ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(s.x,s.y, 3*s.r, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  function frame(ts){
    if (paused){ requestAnimationFrame(frame); return; }
    const t = (ts||performance.now())/1000; const dt = Math.min(0.05, (ts-lastTs)/1000 || 0.016); lastTs=ts;
    resize();

    // cold gradient background
    const bg = ctx.createLinearGradient(0,0,0,H);
    bg.addColorStop(0, 'rgb(8,16,28)');
    bg.addColorStop(1, 'rgb(2,4,10)');
    ctx.fillStyle = bg; ctx.fillRect(0,0,W,H);

    // frosty haze
    ctx.globalAlpha = 0.15 + urgency*0.08;
    ctx.fillStyle = '#0b1620';
    ctx.fillRect(0,0,W,H);
    ctx.globalAlpha = 1;

    // flakes
    for(let i=0;i<MAX_FLAKES;i++){
      const p = flakes[i];
      p.life += dt; if (p.life>p.maxLife){ continue; }
      p.ang += p.spin*dt;
      // sway
      p.vx += Math.sin(t*0.7 + p.y*0.01) * 0.2;
      p.x += p.vx*dt; p.y += p.vy*dt;
      if (p.y > H + 10){ p.life = p.maxLife+1; continue; }
      drawFlake(p, t);
    }

    // sparkles
    for(let i=0;i<MAX_SPARK;i++){
      const s = sparks[i];
      s.life += dt; if (s.life> s.maxLife) continue;
      drawSparkle(s);
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
