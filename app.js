// 美顏相機 v1：即時磨皮、美白、紅潤、濾鏡、拍照下載（全部在瀏覽器本機處理）
(() => {
  const $ = (id) => document.getElementById(id);
  const video = $("video"), canvas = $("view"), msg = $("msg");
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: false });

  const FILTERS = ["原圖", "底片", "日系", "冷調", "暖調", "黑白"];
  let filterId = 0, facing = "user", stream = null, running = false, timerSec = 0;

  // ---------- WebGL ----------
  const VS = `
    attribute vec2 p; uniform float mirror; varying vec2 uv;
    void main(){
      uv = vec2(p.x*.5+.5, .5-p.y*.5);
      if (mirror > .5) uv.x = 1.0 - uv.x;
      gl_Position = vec4(p, 0., 1.);
    }`;

  const FS = `
    precision mediump float;
    varying vec2 uv; uniform sampler2D tex; uniform vec2 texel;
    uniform float smoothAmt, whiteAmt, warmAmt, filt;

    float luma(vec3 c){ return dot(c, vec3(.299,.587,.114)); }

    void main(){
      vec3 c = texture2D(tex, uv).rgb;

      // 膚色遮罩（YCbCr），只在皮膚範圍磨皮，保留眼睛、頭髮、背景細節
      float cb = .5 + dot(c, vec3(-.1687,-.3313,.5));
      float cr = .5 + dot(c, vec3(.5,-.4187,-.0813));
      float skin = smoothstep(.28,.32,cb)*(1.-smoothstep(.48,.52,cb))
                 * smoothstep(.50,.54,cr)*(1.-smoothstep(.66,.70,cr));

      // 雙邊濾波：保邊磨皮
      vec3 sum = c; float wsum = 1.0;
      for (int i = 0; i < 16; i++){
        float a = float(i) * 0.3927;               // 2π/16
        float r = (i < 8) ? 3.0 : 6.0;
        vec2 o = vec2(cos(a), sin(a)) * r * texel;
        vec3 s = texture2D(tex, uv + o).rgb;
        vec3 d = s - c;
        float w = exp(-dot(d,d) * 90.0);
        sum += s * w; wsum += w;
      }
      vec3 blur = sum / wsum;
      float k = smoothAmt * skin;
      c = mix(c, blur, k);
      // 找回一點細節，避免塑膠感
      c += (texture2D(tex, uv).rgb - blur) * 0.25 * k;

      // 美白（提亮暗部、略減對比）
      float y = luma(c);
      c += whiteAmt * 0.18 * (1.0 - y) * (0.4 + skin);
      // 紅潤（膚色區加暖粉）
      c += vec3(.06,.01,.015) * warmAmt * skin;

      // 濾鏡
      if (filt > .5 && filt < 1.5){        // 底片
        c = mix(vec3(luma(c)), c, .85);
        c = c * vec3(1.06,1.0,.92) + vec3(.03,.02,.0);
        c = (c - .5) * .92 + .52;
      } else if (filt < 2.5 && filt > 1.5){ // 日系
        c = (c - .5) * .82 + .58;
        c *= vec3(.97,1.02,1.04);
        c = mix(vec3(luma(c)), c, .9);
      } else if (filt < 3.5 && filt > 2.5){ // 冷調
        c *= vec3(.92,1.0,1.1);
      } else if (filt < 4.5 && filt > 3.5){ // 暖調
        c *= vec3(1.1,1.0,.9);
      } else if (filt > 4.5){               // 黑白
        c = vec3(luma(c));
        c = (c - .5) * 1.1 + .5;
      }
      gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
    }`;

  function sh(type, src){
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog); gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
                        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
    gl.texParameteri(gl.TEXTURE_2D, k, v);

  const U = (n) => gl.getUniformLocation(prog, n);
  const u = { mirror: U("mirror"), texel: U("texel"), smooth: U("smoothAmt"),
              white: U("whiteAmt"), warm: U("warmAmt"), filt: U("filt") };

  function render(){
    if (!running) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const w = video.videoWidth, h = video.videoHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h);
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      const s = Math.max(1, w / 640);               // 依解析度縮放取樣半徑
      gl.uniform1f(u.mirror, facing === "user" ? 1 : 0);
      gl.uniform2f(u.texel, s / w, s / h);
      gl.uniform1f(u.smooth, $("smooth").value / 100);
      gl.uniform1f(u.white, $("white").value / 100);
      gl.uniform1f(u.warm, $("warm").value / 100);
      gl.uniform1f(u.filt, filterId);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    requestAnimationFrame(render);
  }

  // ---------- 相機 ----------
  async function startCamera(){
    stopCamera();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      video.srcObject = stream;
      await video.play();
      msg.hidden = true; running = true; render();
    } catch (e) {
      msg.hidden = false;
      msg.textContent = "無法開啟相機：請允許相機權限，並確認網址是 https。";
      console.error(e);
    }
  }
  function stopCamera(){
    running = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  // ---------- 濾鏡按鈕 ----------
  FILTERS.forEach((name, i) => {
    const b = document.createElement("button");
    b.textContent = name; if (i === 0) b.className = "on";
    b.onclick = () => {
      filterId = i;
      [...$("filters").children].forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
    };
    $("filters").appendChild(b);
  });

  // ---------- 拍照 ----------
  let lastBlob = null, lastUrl = null;
  function capture(){
    canvas.toBlob((blob) => {
      if (!blob) return;
      lastBlob = blob;
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(blob);
      $("photo").src = lastUrl;
      $("download").href = lastUrl;
      $("download").download = "beauty-" + Date.now() + ".jpg";
      $("preview").hidden = false;
    }, "image/jpeg", 0.95);
  }

  async function shoot(){
    if (!running) { await startCamera(); return; }
    if (timerSec > 0) {
      const el = $("countdown"); el.hidden = false;
      for (let t = timerSec; t > 0; t--) { el.textContent = t; await new Promise((r) => setTimeout(r, 1000)); }
      el.hidden = true;
    }
    capture();
  }

  $("shutter").onclick = shoot;
  $("flip").onclick = () => { facing = facing === "user" ? "environment" : "user"; startCamera(); };
  $("timer").onclick = () => {
    timerSec = timerSec === 0 ? 3 : timerSec === 3 ? 5 : timerSec === 5 ? 10 : 0;
    $("timer").textContent = "⏱ " + timerSec;
  };
  $("retake").onclick = () => { $("preview").hidden = true; };
  $("share").onclick = async () => {
    if (!lastBlob) return;
    const file = new File([lastBlob], "beauty.jpg", { type: "image/jpeg" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (_) {}
    } else {
      alert("這個瀏覽器不支援直接分享，請改用「下載」。");
    }
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera();
    else if (stream) startCamera();
  });
})();
