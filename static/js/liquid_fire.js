/* Liquid Fire WebGL Background (fbm + additive ripples driven by onNumberChange)
   Usage:
     - This script auto-initializes when #gl-container exists.
     - Call window.onNumberChange(remainingSeconds) from your countdown logic.
     - Optionally call window.setTotalSeconds(totalSeconds) so urgency palette tracks total duration.
*/
(function(){
  const container = document.getElementById('gl-container');
  if (!container) return;

  const canvas = document.createElement('canvas');
  canvas.id = 'liquid-fire-bg';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.style.zIndex = '0';
  container.appendChild(canvas);

  const gl = canvas.getContext('webgl', {antialias:false, alpha:false});
  if(!gl){ console.warn('[liquid-fire] WebGL unavailable'); return; }

  const MAX_IMP = 16;
  const vsrc = `
  attribute vec2 position;
  void main(){ gl_Position = vec4(position,0.0,1.0); }
  `;
  const fsrc = `
  precision highp float;
  uniform vec2  u_res;
  uniform float u_time;
  uniform float u_urgency;   // 0..1 (cool->hot)
  uniform int   u_impCount;
  uniform vec3  u_imp[${MAX_IMP}]; // x,y,timeBorn (normalized 0..1 coords)

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p){
    vec2 i=floor(p), f=fract(p);
    float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
    vec2 u=f*f*(3.-2.*f);
    return mix(a,b,u.x) + (c-a)*u.y*(1.-u.x) + (d-b)*u.x*u.y;
  }
  float fbm(vec2 p){
    float v=0., a=.5;
    for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.02; a*=.5; }
    return v;
  }

  float ripple(vec2 uv, vec2 c, float born){
    float t = u_time - born;
    if(t<0.0) return 0.0;
    float d = distance(uv, c);
    float wave = sin(24.0*(d - t*0.25));
    float atten = exp(-6.0*d) * exp(-1.5*t);
    return wave * atten;
  }

  vec3 pal(float x){
    vec3 cool = vec3(0.02,0.10,0.25);
    vec3 mid  = vec3(0.35,0.15,0.55);
    vec3 hot  = vec3(1.00,0.35,0.08);
    vec3 a = mix(cool, mid, smoothstep(0.0, 0.6, u_urgency));
    vec3 b = mix(mid,  hot, smoothstep(0.6, 1.0, u_urgency));
    vec3 base = mix(a,b, u_urgency);
    return base * (0.6 + 0.8*x);
  }

  void main(){
    vec2 uv = gl_FragCoord.xy / u_res;
    float t = u_time*0.12;
    vec2 q = uv*2.0;
    float f1 = fbm(q + vec2(0.0,t));
    float f2 = fbm(q*1.7 - vec2(t*0.9, t*0.6));
    float h  = f1*0.6 + f2*0.4;

    float rip = 0.0;
    for(int i=0;i<${MAX_IMP};i++){
      if(i>=u_impCount) break;
      vec2 c = u_imp[i].xy;
      float born = u_imp[i].z;
      rip += ripple(uv, c, born);
    }

    float refr = fbm(q + rip*vec2(0.8, -0.6));
    vec3 col = pal(smoothstep(0.2, 0.9, refr));

    float vgg = smoothstep(0.0, 0.9, 1.0 - distance(uv, vec2(0.5)));
    col *= vgg;

    gl_FragColor = vec4(col, 1.0);
  }
  `;

  function sh(type,src){ const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(s); return s; }
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vsrc));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fsrc));
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw gl.getProgramInfoLog(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1,-1,  1,-1, -1, 1,
    -1, 1,  1,-1,  1, 1,
  ]), gl.STATIC_DRAW);
  const locPos = gl.getAttribLocation(prog, 'position');
  gl.enableVertexAttribArray(locPos);
  gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog,'u_res');
  const uTime= gl.getUniformLocation(prog,'u_time');
  const uUrg = gl.getUniformLocation(prog,'u_urgency');
  const uImpCount = gl.getUniformLocation(prog,'u_impCount');
  const uImp = [...Array(MAX_IMP)].map((_,i)=>gl.getUniformLocation(prog,`u_imp[${i}]`));

  function resize(){
    const dpr = Math.min(window.devicePixelRatio||1, 2);
    const w = Math.max(1, Math.floor(container.clientWidth * dpr));
    const h = Math.max(1, Math.floor(container.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h){
      canvas.width  = w;
      canvas.height = h;
      gl.viewport(0,0,w,h);
      gl.uniform2f(uRes, w, h);
    }
  }
  window.addEventListener('resize', resize); resize();

  const impulses = []; // {x,y,born}
  let urgency = 0.0;   // 0..1
  let totalSeconds = 70*60; // default; can be overridden via setTotalSeconds

  function pushImpulse(nx, ny){
    const born = performance.now()/1000;
    impulses.push({x:nx, y:ny, born});
    if(impulses.length > MAX_IMP) impulses.shift();
  }

  function flareForTick(remainingSec){
    const isMinute = (remainingSec > 0 && (remainingSec % 60 === 0));
    const base = Math.min(6, 1 + Math.floor(urgency*4));
    const bursts = isMinute ? base + 6 : base;
    for(let i=0;i<bursts;i++){
      const x = 0.2 + 0.6*Math.random();
      const y = 0.2 + 0.6*Math.random();
      pushImpulse(x, y);
    }
  }

  // Expose hooks
  window.setTotalSeconds = function setTotalSeconds(total){
    if (typeof total === 'number' && total > 0) totalSeconds = total;
  };
  window.onNumberChange = function onNumberChange(remainingSec){
    const rem = Math.max(0, Number(remainingSec||0));
    const tot = Math.max(1, totalSeconds||1);
    urgency = Math.min(1, 1 - rem / tot);
    flareForTick(rem);
  };

  function draw(tms){
    resize();
    const t = (tms||performance.now())/1000;
    gl.uniform1f(uTime, t);
    gl.uniform1f(uUrg, urgency);
    const n = Math.min(impulses.length, MAX_IMP);
    gl.uniform1i(uImpCount, n);
    for(let i=0;i<n;i++){
      const p = impulses[i];
      gl.uniform3f(uImp[i], p.x, p.y, p.born);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
})();
