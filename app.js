// 美顏相機 v2：即時美膚 + MediaPipe 人臉關鍵點（瘦臉、大眼、亮眼、美牙、唇色）+ 濾鏡 + 拍照
// 所有影像處理都在瀏覽器本機完成，照片不會上傳。
(() => {
  const $ = (id) => document.getElementById(id);
  const val = (id) => +$(id).value / 100;
  const video = $("video"), canvas = $("view"), msg = $("msg"), statusEl = $("status");
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: false });

  const FILTERS = ["原圖", "底片", "日系", "冷調", "暖調", "黑白"];
  const FACE_SLIDERS = ["eye", "bright", "teeth", "lip", "chin", "mouth", "smile"];
  let filterId = 0, facing = "user", stream = null, running = false, timerSec = 0;

  // ---------- 狀態提示 ----------
  let lastStatus = null;
  function setStatus(text) {
    if (text === lastStatus) return;
    lastStatus = text;
    statusEl.hidden = !text;
    statusEl.textContent = text || "";
  }

  // ---------- WebGL shader ----------
  const VS = `
    attribute vec2 p; uniform float mirror; varying vec2 uv;
    void main(){
      uv = vec2(p.x*.5+.5, .5-p.y*.5);
      if (mirror > .5) uv.x = 1.0 - uv.x;
      gl_Position = vec4(p, 0., 1.);
    }`;

  const FS = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    varying vec2 uv;
    uniform sampler2D tex;
    uniform sampler2D mask;          // R=眼睛 G=口腔內側(牙齒) B=嘴唇外輪廓
    uniform vec2 texel;
    uniform float asp, smoothAmt, whiteAmt, warmAmt, filt;
    uniform float eyeN, xN, maskOn, eyeBright, teethAmt, lipAmt;
    uniform vec2 faceR;              // 每張臉的下巴/嘴角作用半徑基準
    uniform vec4 eyeA[6];            // 凸透鏡：(中心xy, 半徑, 強度)，每張臉 = 左眼、右眼、嘴巴
    uniform vec4 xA[6];              // 下巴/嘴角控制點，每張臉 3 個：下巴、嘴角×2

    float luma(vec3 c){ return dot(c, vec3(.299,.587,.114)); }

    // 局部變形（反向對應）：瘦臉＝局部平移，大眼＝凸透鏡
    vec2 warp(vec2 uv0){
      vec2 p = vec2(uv0.x * asp, uv0.y);
      for (int i = 0; i < 6; i++){
        if (float(i) >= xN) break;
        vec4 a = xA[i];
        int jj = (i < 3) ? i : i - 3;
        float rf = (jj == 0) ? 0.7 : 0.45;                      // 下巴 / 嘴角 的作用半徑比例
        float r = rf * ((i < 3) ? faceR.x : faceR.y);
        vec2 d = p - a.xy;
        float r2 = r * r, d2 = dot(d, d);
        if (d2 < r2){
          vec2 m = a.zw - a.xy;
          float k = (r2 - d2) / (r2 - d2 + dot(m, m));
          p -= k * k * m;
        }
      }
      for (int j = 0; j < 6; j++){
        if (float(j) >= eyeN) break;
        vec4 e = eyeA[j];
        vec2 d = p - e.xy;
        float dist = length(d);
        if (dist < e.z){
          float t = 1.0 - dist / e.z;
          p = e.xy + d * (1.0 - e.w * t * t);
        }
      }
      return vec2(p.x / asp, p.y);
    }

    void main(){
      vec2 suv = warp(uv);
      vec3 c0 = texture2D(tex, suv).rgb;
      vec3 c = c0;

      // 膚色遮罩（YCbCr）：只在皮膚範圍磨皮
      float cb = .5 + dot(c, vec3(-.1687,-.3313,.5));
      float cr = .5 + dot(c, vec3(.5,-.4187,-.0813));
      float skin = smoothstep(.28,.32,cb)*(1.-smoothstep(.48,.52,cb))
                 * smoothstep(.50,.54,cr)*(1.-smoothstep(.66,.70,cr));

      // 雙邊濾波：保邊磨皮
      vec3 sum = c; float wsum = 1.0;
      for (int i = 0; i < 16; i++){
        float a = float(i) * 0.3927;
        float r = (i < 8) ? 3.0 : 6.0;
        vec2 o = vec2(cos(a), sin(a)) * r * texel;
        vec3 s = texture2D(tex, suv + o).rgb;
        vec3 d = s - c;
        float w = exp(-dot(d,d) * 90.0);
        sum += s * w; wsum += w;
      }
      vec3 blur = sum / wsum;
      float k = smoothAmt * skin;
      c = mix(c, blur, k);
      c += (c0 - blur) * 0.25 * k;

      // 美白、紅潤
      float y = luma(c);
      c += whiteAmt * 0.18 * (1.0 - y) * (0.4 + skin);
      c += vec3(.06,.01,.015) * warmAmt * skin;

      // 五官細部：亮眼、美牙、唇色
      if (maskOn > .5){
        vec3 mk = texture2D(mask, suv).rgb;
        float lipM = mk.b * (1.0 - mk.g);
        c = mix(c, (c - .45) * 1.3 + .54, mk.r * eyeBright);          // 亮眼：提高眼白/瞳孔對比
        float yy = luma(c);
        float tw = mk.g * teethAmt * smoothstep(.30, .55, yy);         // 美牙：去黃提亮（跳過暗的口腔）
        c = mix(c, mix(vec3(yy), c, .35) * 1.1 + .04, tw);
        c = mix(c, vec3(.80,.18,.28) * (.45 + yy), lipM * lipAmt * .5); // 唇色
      }

      // 濾鏡
      if (filt > .5 && filt < 1.5){
        c = mix(vec3(luma(c)), c, .85);
        c = c * vec3(1.06,1.0,.92) + vec3(.03,.02,.0);
        c = (c - .5) * .92 + .52;
      } else if (filt < 2.5 && filt > 1.5){
        c = (c - .5) * .82 + .58;
        c *= vec3(.97,1.02,1.04);
        c = mix(vec3(luma(c)), c, .9);
      } else if (filt < 3.5 && filt > 2.5){
        c *= vec3(.92,1.0,1.1);
      } else if (filt < 4.5 && filt > 3.5){
        c *= vec3(1.1,1.0,.9);
      } else if (filt > 4.5){
        c = vec3(luma(c));
        c = (c - .5) * 1.1 + .5;
      }
      gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
    }`;

  function sh(type, src) {
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

  function makeTexture(unit) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const videoTex = makeTexture(0);
  const maskTex = makeTexture(1);

  const U = (n) => gl.getUniformLocation(prog, n);
  const u = {
    mirror: U("mirror"), texel: U("texel"), asp: U("asp"),
    smooth: U("smoothAmt"), white: U("whiteAmt"), warm: U("warmAmt"), filt: U("filt"),
    eyeN: U("eyeN"), maskOn: U("maskOn"),
    eyeBright: U("eyeBright"), teeth: U("teethAmt"), lip: U("lipAmt"),
    faceR: U("faceR"), eyeA: U("eyeA"), xA: U("xA"), xN: U("xN"),
  };
  gl.uniform1i(U("tex"), 0);
  gl.uniform1i(U("mask"), 1);

  // ---------- MediaPipe 人臉關鍵點 ----------
  const MP_VERSION = "0.10.14";
  const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
  const MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

  let landmarker = null;
  async function initFace() {
    setStatus("載入人臉偵測中…");
    try {
      const { FaceLandmarker, FilesetResolver } = await import(`${MP_BASE}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const make = (delegate) => FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: "VIDEO", numFaces: 2,
      });
      try { landmarker = await make("GPU"); } catch (_) { landmarker = await make("CPU"); }
      setStatus(null);
    } catch (e) {
      console.error(e);
      setStatus("人臉功能載入失敗（美膚與濾鏡仍可使用）");
    }
  }

  // 平滑後的人臉關鍵點：每張臉是 Float32Array [x0,y0,x1,y1,...]（0~1 正規化）
  let faces = [], lastVT = -1;
  function detect() {
    const need = FACE_SLIDERS.some((id) => val(id) !== 0);
    if (!need || !landmarker) { faces = []; return; }
    if (video.currentTime === lastVT) return;
    lastVT = video.currentTime;
    let res;
    try { res = landmarker.detectForVideo(video, performance.now()); } catch (_) { return; }
    const raw = res.faceLandmarks || [];
    if (raw.length !== faces.length) {
      faces = raw.map((lm) => {
        const a = new Float32Array(lm.length * 2);
        lm.forEach((p, i) => { a[2*i] = p.x; a[2*i+1] = p.y; });
        return a;
      });
    } else {
      raw.forEach((lm, f) => {
        const a = faces[f];
        for (let i = 0; i < lm.length; i++) {            // 指數平滑，減少抖動
          a[2*i]   += (lm[i].x - a[2*i])   * 0.6;
          a[2*i+1] += (lm[i].y - a[2*i+1]) * 0.6;
        }
      });
    }
  }

  // 臉部輪廓點（MediaPipe 468/478 點網格的索引）
  const EYE_DEFS = [[468, 33, 133], [473, 362, 263]];         // [虹膜中心, 眼角1, 眼角2]
  const EYE_L = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246];
  const EYE_R = [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398];
  const MOUTH_IN = [78,95,88,178,87,14,317,402,318,324,308,415,310,311,312,13,82,81,80,191];
  const LIP_OUT = [61,146,91,181,84,17,314,405,321,375,291,409,270,269,267,0,37,39,40,185];

  // 嘴唇/眼睛/牙齒遮罩（小畫布，拿來當第二張貼圖）
  const MS = 384;
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = maskCanvas.height = MS;
  const mctx = maskCanvas.getContext("2d");
  function poly(a, idx, color) {
    mctx.fillStyle = color; mctx.beginPath();
    idx.forEach((i, n) => {
      const x = a[2*i] * MS, y = a[2*i+1] * MS;
      n ? mctx.lineTo(x, y) : mctx.moveTo(x, y);
    });
    mctx.closePath(); mctx.fill();
  }
  function drawMask() {
    mctx.globalCompositeOperation = "source-over";
    mctx.fillStyle = "#000"; mctx.fillRect(0, 0, MS, MS);
    mctx.globalCompositeOperation = "lighter";
    for (const a of faces) {
      poly(a, EYE_L, "#f00"); poly(a, EYE_R, "#f00");
      poly(a, MOUTH_IN, "#0f0"); poly(a, LIP_OUT, "#00f");
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    gl.activeTexture(gl.TEXTURE0);
  }

  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

  // 把關鍵點轉成 shader 要的變形參數（座標單位＝影像高度）
  function uploadFaceUniforms(W, H) {
    const big = val("eye");
    const chinAmt = val("chin"), mouthS = val("mouth"), smile = val("smile");
    const nf = Math.min(faces.length, 2);
    const eyes = new Float32Array(24), ext = new Float32Array(24), radii = [0, 0];
    let ei = 0, xi = 0;

    for (let f = 0; f < nf; f++) {
      const a = faces[f];
      const P = (i) => [a[2*i] * W, a[2*i+1] * H];
      const top = P(168), chin = P(152);
      let ax = [chin[0] - top[0], chin[1] - top[1]];
      const len = Math.hypot(ax[0], ax[1]) || 1;
      ax = [ax[0] / len, ax[1] / len];
      radii[f] = dist(P(234), P(454)) * 0.22 / H;

      for (const [ir, c1, c2] of EYE_DEFS) {
        const p1 = P(c1), p2 = P(c2);
        const C = a.length / 2 > ir ? P(ir) : [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
        eyes.set([C[0] / H, C[1] / H, dist(p1, p2) * 0.8 / H, big * 0.5], ei); ei += 4;
      }

      // 嘴型：以嘴巴中心做凸透鏡（正＝放大、負＝縮小）
      const m1 = P(61), m2 = P(291);
      eyes.set([(m1[0] + m2[0]) / 2 / H, (m1[1] + m2[1]) / 2 / H, dist(m1, m2) * 0.6 / H, mouthS * 0.3], ei);
      ei += 4;

      // 下巴、嘴角：每張臉固定 3 個控制點
      const fw = dist(P(234), P(454));
      const addX = (C, M) => { ext.set([C[0] / H, C[1] / H, M[0] / H, M[1] / H], xi); xi += 4; };

      const cc = P(152);                                           // 下巴：正＝縮短、負＝拉長
      addX(cc, [cc[0] - ax[0] * chinAmt * 0.08 * fw, cc[1] - ax[1] * chinAmt * 0.08 * fw]);
      for (const idx of [61, 291]) {                               // 微笑：嘴角往上提
        const C = P(idx);
        addX(C, [C[0] - ax[0] * smile * 0.05 * fw, C[1] - ax[1] * smile * 0.05 * fw]);
      }
    }
    gl.uniform4fv(u.eyeA, eyes);
    gl.uniform4fv(u.xA, ext);
    gl.uniform2f(u.faceR, radii[0], radii[1]);
    gl.uniform1f(u.eyeN, (big > 0 || mouthS !== 0) ? nf * 3 : 0);
    gl.uniform1f(u.xN, (chinAmt !== 0 || smile > 0) ? nf * 3 : 0);
    gl.uniform1f(u.maskOn, nf > 0 ? 1 : 0);
    gl.uniform1f(u.eyeBright, val("bright"));
    gl.uniform1f(u.teeth, val("teeth"));
    gl.uniform1f(u.lip, val("lip"));
    if (nf > 0) drawMask();
  }

  // ---------- 繪製迴圈 ----------
  function render() {
    if (!running) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const w = video.videoWidth, h = video.videoHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h);
      }
      detect();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);

      const s = Math.max(1, w / 640);
      gl.uniform1f(u.mirror, facing === "user" ? 1 : 0);
      gl.uniform2f(u.texel, s / w, s / h);
      gl.uniform1f(u.asp, w / h);
      gl.uniform1f(u.smooth, val("smooth"));
      gl.uniform1f(u.white, val("white"));
      gl.uniform1f(u.warm, val("warm"));
      gl.uniform1f(u.filt, filterId);
      uploadFaceUniforms(w, h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (landmarker && FACE_SLIDERS.some((id) => val(id) !== 0))
        setStatus(faces.length ? null : "未偵測到人臉");
      else if (landmarker) setStatus(null);
    }
    requestAnimationFrame(render);
  }

  // ---------- 相機 ----------
  async function startCamera() {
    stopCamera();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      video.srcObject = stream;
      await video.play();
      faces = []; lastVT = -1;
      msg.hidden = true; running = true; render();
    } catch (e) {
      msg.hidden = false;
      msg.textContent = "無法開啟相機：請允許相機權限，並確認網址是 https。";
      console.error(e);
    }
  }
  function stopCamera() {
    running = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  // ---------- 分頁與濾鏡按鈕 ----------
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
      document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("on", p.id === "tab-" + b.dataset.tab));
    };
  });

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
  function capture() {
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

  async function shoot() {
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

  initFace();
})();
