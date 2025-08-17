/* Minimal WebGL Fluid Simulation (inspired by Pavel Dobryakov)
   API:
     const fluid = initFluid(containerElement, options?)
     fluid.splat(x, y, colorRGBArray, radius?, forceVec2?)
     fluid.splatRandom(count, opts?)
     fluid.resize()
     fluid.destroy()

   Notes:
   - This is a compact adaptation providing dye advection, velocity advection, viscous-like diffusion via multiple pressure iterations, and a splat() function for injecting dye/velocity.
   - It is geared for background visuals and not a physically perfect solver. It runs fully on GPU and is efficient enough for displays.
*/
(function(){
  function createGL(canvas){
    const gl = canvas.getContext('webgl2', { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 not supported');
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    return gl;
  }

  function compile(gl, type, source){
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
      const info = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('Shader compile error: '+info+'\n'+source);
    }
    return s;
  }
  function program(gl, vertSrc, fragSrc){
    const p = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, vertSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)){
      const info = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('Program link error: '+info);
    }
    return p;
  }

  const baseVert = `#version 300 es
    precision highp float;
    layout(location=0) in vec2 aPos;
    out vec2 vUv;
    void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }
  `;

  const copyFrag = `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uTex;
    void main(){ o = texture(uTex, vUv); }
  `;

  const advectFrag = `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uSrc; // field to advect
    uniform sampler2D uVel; // velocity field
    uniform vec2 uTexel;
    uniform float uDt;
    void main(){
      vec2 v = texture(uVel, vUv).xy * 1.0; // pixels/sec in NDC space
      vec2 coord = vUv - uDt * v * uTexel; // backtrace
      o = texture(uSrc, coord);
    }
  `;

  const divergenceFrag = `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uVel;
    uniform vec2 uTexel;
    void main(){
      float L = texture(uVel, vUv - vec2(uTexel.x, 0.0)).x;
      float R = texture(uVel, vUv + vec2(uTexel.x, 0.0)).x;
      float B = texture(uVel, vUv - vec2(0.0, uTexel.y)).y;
      float T = texture(uVel, vUv + vec2(0.0, uTexel.y)).y;
      float div = 0.5 * ((R - L) + (T - B));
      o = vec4(div,0.0,0.0,1.0);
    }
  `;

  const clearFrag = `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uTex;
    uniform float uDissipation;
    void main(){
      vec4 c = texture(uTex, vUv);
      o = c * uDissipation;
    }
  `;

  const pressureFrag = `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    uniform vec2 uTexel;
    void main(){
      float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
      float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
      float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
      float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
      float div = texture(uDivergence, vUv).x;
      float p = (L + R + B + T - div) * 0.25;
      o = vec4(p,0.0,0.0,1.0);
    }
  `;

  const gradientSubtractFrag = `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uVel;
    uniform sampler2D uPressure;
    uniform vec2 uTexel;
    void main(){
      float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
      float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
      float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
      float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
      vec2 grad = vec2(R - L, T - B) * 0.5;
      vec2 v = texture(uVel, vUv).xy - grad;
      o = vec4(v,0.0,1.0);
    }
  `;

  const splatFrag = `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uTarget;
    uniform vec2 uPoint; // 0..1
    uniform vec3 uColor;
    uniform float uRadius; // in 0..1 where 1 is min(dim)
    void main(){
      vec2 p = vUv;
      float d = distance(p, uPoint);
      float a = exp(- (d*d) / max(1e-6, uRadius*uRadius));
      vec4 base = texture(uTarget, vUv);
      o = base + vec4(uColor * a, a);
    }
  `;

  const splatVelFrag = `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uTarget;
    uniform vec2 uPoint; // 0..1
    uniform vec2 uForce; // velocity push
    uniform float uRadius;
    void main(){
      float d = distance(vUv, uPoint);
      float a = exp(- (d*d) / max(1e-6, uRadius*uRadius));
      vec2 v = texture(uTarget, vUv).xy + uForce * a;
      o = vec4(v, 0.0, 1.0);
    }
  `;

  const displayFrag = `#version 300 es
    precision highp float;
    in vec2 vUv; out vec4 o;
    uniform sampler2D uDye;
    void main(){ o = texture(uDye, vUv); }
  `;

  function createFBO(gl, w, h, internalFormat, format, type, filter){
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0,0,w,h);

    return { tex, fbo, w, h };
  }

  function createDoubleFBO(gl, w, h, internalFormat, format, type, filter){
    const fbo1 = createFBO(gl, w, h, internalFormat, format, type, filter);
    const fbo2 = createFBO(gl, w, h, internalFormat, format, type, filter);
    return {
      get read(){ return fbo1; },
      get write(){ return fbo2; },
      swap(){ const t = fbo1.tex; fbo1.tex = fbo2.tex; fbo2.tex = t; const tf = fbo1.fbo; fbo1.fbo=fbo2.fbo; fbo2.fbo=tf; }
    };
  }

  function quad(gl){
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const verts = new Float32Array([
      -1,-1,  1,-1,  -1,1,
       1,-1,  1, 1,  -1,1
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    return vao;
  }

  function initFluid(container, opts){
    opts = opts || {};
    const dpr = Math.min(window.devicePixelRatio || 1, opts.maxDPR || 2);

    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.zIndex = '0';
    container.appendChild(canvas);

    const gl = createGL(canvas);

    const fmt = gl.RGBA16F; // good quality
    const type = gl.HALF_FLOAT;
    const filter = gl.LINEAR;

    const prgCopy = program(gl, baseVert, copyFrag);
    const prgAdvect = program(gl, baseVert, advectFrag);
    const prgDiv = program(gl, baseVert, divergenceFrag);
    const prgClear = program(gl, baseVert, clearFrag);
    const prgPressure = program(gl, baseVert, pressureFrag);
    const prgGrad = program(gl, baseVert, gradientSubtractFrag);
    const prgSplat = program(gl, baseVert, splatFrag);
    const prgSplatVel = program(gl, baseVert, splatVelFrag);
    const prgDisplay = program(gl, baseVert, displayFrag);

    const vao = quad(gl);

    let width = 0, height = 0;
    const sim = {
      canvas, gl,
      resize,
      splat,
      splatRandom,
      destroy(){ try{ gl.getExtension; }catch(e){} if (canvas.parentNode) canvas.parentNode.removeChild(canvas); },
    };

    function setSize(){
      const w = Math.max(2, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(2, Math.floor(canvas.clientHeight * dpr));
      if (w === width && h === height) return false;
      width = w; height = h; canvas.width = w; canvas.height = h;
      dye = createDoubleFBO(gl, w, h, fmt, gl.RGBA, type, filter);
      velocity = createDoubleFBO(gl, w, h, gl.RG16F, gl.RG, type, filter);
      pressure = createDoubleFBO(gl, w, h, gl.R16F, gl.RED, type, gl.NEAREST);
      divergence = createFBO(gl, w, h, gl.R16F, gl.RED, type, gl.NEAREST);
      texel.set(1/width, 1/height);
      return true;
    }

    let dye, velocity, pressure, divergence;
    const texel = new Float32Array([0,0]);
    let lastT = performance.now();
    const clearDye = 0.995; // dissipation
    const clearVel = 0.995;
    const pressureIters = 15;

    function bindAndDraw(prg, uniforms){
      gl.useProgram(prg);
      gl.bindVertexArray(vao);
      if (uniforms) uniforms();
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    function advect(dst, src, vel, dt){
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      bindAndDraw(prgAdvect, ()=>{
        let loc;
        loc = gl.getUniformLocation(prgAdvect, 'uSrc'); gl.uniform1i(loc, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
        loc = gl.getUniformLocation(prgAdvect, 'uVel'); gl.uniform1i(loc, 1); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, vel.tex);
        loc = gl.getUniformLocation(prgAdvect, 'uTexel'); gl.uniform2f(loc, texel[0], texel[1]);
        loc = gl.getUniformLocation(prgAdvect, 'uDt'); gl.uniform1f(loc, dt);
      });
    }

    function applyDissipation(dst, src, diss){
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      bindAndDraw(prgClear, ()=>{
        let loc;
        loc = gl.getUniformLocation(prgClear, 'uTex'); gl.uniform1i(loc, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
        loc = gl.getUniformLocation(prgClear, 'uDissipation'); gl.uniform1f(loc, diss);
      });
    }

    function computeDivergence(){
      gl.bindFramebuffer(gl.FRAMEBUFFER, divergence.fbo);
      bindAndDraw(prgDiv, ()=>{
        let loc;
        loc = gl.getUniformLocation(prgDiv, 'uVel'); gl.uniform1i(loc, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, velocity.read.tex);
        loc = gl.getUniformLocation(prgDiv, 'uTexel'); gl.uniform2f(loc, texel[0], texel[1]);
      });
    }

    function solvePressure(){
      // clear pressure
      gl.bindFramebuffer(gl.FRAMEBUFFER, pressure.write.fbo);
      gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
      pressure.swap();
      for(let i=0;i<pressureIters;i++){
        gl.bindFramebuffer(gl.FRAMEBUFFER, pressure.write.fbo);
        bindAndDraw(prgPressure, ()=>{
          let loc;
          loc = gl.getUniformLocation(prgPressure, 'uPressure'); gl.uniform1i(loc, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, pressure.read.tex);
          loc = gl.getUniformLocation(prgPressure, 'uDivergence'); gl.uniform1i(loc, 1); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, divergence.tex);
          loc = gl.getUniformLocation(prgPressure, 'uTexel'); gl.uniform2f(loc, texel[0], texel[1]);
        });
        pressure.swap();
      }
    }

    function subtractGradient(){
      gl.bindFramebuffer(gl.FRAMEBUFFER, velocity.write.fbo);
      bindAndDraw(prgGrad, ()=>{
        let loc;
        loc = gl.getUniformLocation(prgGrad, 'uVel'); gl.uniform1i(loc, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, velocity.read.tex);
        loc = gl.getUniformLocation(prgGrad, 'uPressure'); gl.uniform1i(loc, 1); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, pressure.read.tex);
        loc = gl.getUniformLocation(prgGrad, 'uTexel'); gl.uniform2f(loc, texel[0], texel[1]);
      });
      velocity.swap();
    }

    function render(){
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      bindAndDraw(prgDisplay, ()=>{
        const loc = gl.getUniformLocation(prgDisplay, 'uDye'); gl.uniform1i(loc, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dye.read.tex);
      });
    }

    function step(){
      const now = performance.now();
      const dt = Math.min(0.032, (now - lastT) / 1000);
      lastT = now;
      // Advect velocity
      advect(velocity.write, velocity.read, velocity.read, dt); velocity.swap();
      // Dissipate velocity slightly
      applyDissipation(velocity.write, velocity.read, clearVel); velocity.swap();
      // Compute pressure
      computeDivergence();
      solvePressure();
      subtractGradient();
      // Advect dye
      advect(dye.write, dye.read, velocity.read, dt); dye.swap();
      // Slightly fade dye to avoid over-bright
      applyDissipation(dye.write, dye.read, clearDye); dye.swap();
      render();
      requestAnimationFrame(step);
    }

    function resize(){
      setSize();
    }

    function splat(x, y, color, radius, force){
      // x,y in 0..1
      radius = radius==null ? 0.04 : radius;
      const cr = Math.max(0.002, radius);
      // Dye
      gl.bindFramebuffer(gl.FRAMEBUFFER, dye.write.fbo);
      bindAndDraw(prgSplat, ()=>{
        let loc;
        loc = gl.getUniformLocation(prgSplat, 'uTarget'); gl.uniform1i(loc, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dye.read.tex);
        loc = gl.getUniformLocation(prgSplat, 'uPoint'); gl.uniform2f(loc, x, y);
        loc = gl.getUniformLocation(prgSplat, 'uColor'); gl.uniform3f(loc, color[0], color[1], color[2]);
        loc = gl.getUniformLocation(prgSplat, 'uRadius'); gl.uniform1f(loc, cr);
      });
      dye.swap();
      // Velocity
      const fx = force && force[0] || 0, fy = force && force[1] || 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, velocity.write.fbo);
      bindAndDraw(prgSplatVel, ()=>{
        let loc;
        loc = gl.getUniformLocation(prgSplatVel, 'uTarget'); gl.uniform1i(loc, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, velocity.read.tex);
        loc = gl.getUniformLocation(prgSplatVel, 'uPoint'); gl.uniform2f(loc, x, y);
        loc = gl.getUniformLocation(prgSplatVel, 'uForce'); gl.uniform2f(loc, fx, fy);
        loc = gl.getUniformLocation(prgSplatVel, 'uRadius'); gl.uniform1f(loc, cr);
      });
      velocity.swap();
    }

    function splatRandom(count, opts){
      opts = opts || {};
      const minR = opts.minRadius || 0.015;
      const maxR = opts.maxRadius || 0.06;
      const maxF = opts.maxForce || 2.5;
      for(let i=0;i<count;i++){
        const x = Math.random();
        const y = Math.random();
        const r = minR + Math.random()*(maxR-minR);
        const a = Math.random()*Math.PI*2;
        const m = (opts.forceScale || 1.0) * (0.2 + 0.8*Math.random());
        const f = [Math.cos(a)*maxF*m, Math.sin(a)*maxF*m];
        const c = opts.color || [Math.random(),Math.random(),Math.random()];
        splat(x,y,c,r,f);
      }
    }

    // Initialize
    setSize();
    requestAnimationFrame(step);

    // Public
    return sim;
  }

  window.initFluid = initFluid;
})();
