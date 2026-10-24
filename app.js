// 美顏相機 v4：即時美膚 + MediaPipe 人臉關鍵點 + 彩妝 + 畫質調整 + 濾鏡 + 拍照
// 所有影像處理都在瀏覽器本機完成，照片不會上傳。
(() => {
  const $ = (id) => document.getElementById(id);
  const val = (id) => { const el = $(id); return el ? +el.value / 100 : 0; };
  const video = $("video"), canvas = $("view"), msg = $("msg"), statusEl = $("status");
  const stage = document.querySelector(".stage"), grid = $("grid");
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: false });

  const FILTERS = ["原圖", "日系", "冷調", "粉嫩", "清透"];
  // 需要人臉關鍵點的滑桿；全部為 0 時不會跑人臉偵測
  const FACE_SLIDERS = ["eye", "mouth", "bright", "teeth", "lip", "blush", "dark", "hi"];
  let filterId = 0, facing = "user", stream = null, running = false, timerSec = 0;

  // 一鍵美顏模式：[滑桿值..., 濾鏡編號]
  const ZERO = { smooth: 0, white: 0, warm: 0, dark: 0, eye: 0, mouth: 0, bright: 0, teeth: 0, lip: 0,
                 blush: 0, hi: 0, bri: 0, con: 0, sat: 0, sharp: 0, vig: 0 };
  const PRESETS = {
    "自然": { filter: 0, v: { ...ZERO, smooth: 35, white: 15, warm: 10, dark: 20, eye: 10, bright: 15, teeth: 20, lip: 10, blush: 8, hi: 10 } },
    "甜美": { filter: 3, v: { ...ZERO, smooth: 55, white: 35, warm: 25, dark: 30, eye: 20, bright: 30, teeth: 40, lip: 30, blush: 40, hi: 15 } },
    "清透": { filter: 4, v: { ...ZERO, smooth: 50, white: 45, warm: 5, dark: 40, eye: 15, bright: 35, teeth: 45, lip: 15, blush: 15, hi: 25, sharp: 20 } },
    "重置": { filter: 0, v: { ...ZERO } },
  };

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
    uniform sampler2D mask2;         // R=腮紅 G=黑眼圈區域 B=立體高光
    uniform vec2 texel;
    uniform float asp, smoothAmt, whiteAmt, warmAmt, filt;
    uniform float eyeN, maskOn, eyeBright, teethAmt, lipAmt, blushAmt, darkAmt, hiAmt;
    uniform float briAmt, conAmt, satAmt, sharpAmt, vigAmt;
    uniform vec4 eyeA[6];            // 凸透鏡：(中心xy, 半徑, 強度)，每張臉 = 左眼、右眼、嘴巴

    float luma(vec3 c){ return dot(c, vec3(.299,.587,.114)); }

    // 局部變形（反向對應）：大眼、嘴型＝凸透鏡
    vec2 warp(vec2 uv0){
      vec2 p = vec2(uv0.x * asp, uv0.y);
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

      // 清晰度（避開已磨皮的皮膚）
      if (sharpAmt > 0.0){
        vec2 o = texel * 1.5;
        vec3 avg = (texture2D(tex, suv + vec2(o.x, 0.)).rgb + texture2D(tex, suv - vec2(o.x, 0.)).rgb
                  + texture2D(tex, suv + vec2(0., o.y)).rgb + texture2D(tex, suv - vec2(0., o.y)).rgb) * .25;
        c += (c0 - avg) * sharpAmt * 1.3 * (1.0 - k);
      }

      // 美白、紅潤
      float y = luma(c);
      c += whiteAmt * 0.18 * (1.0 - y) * (0.4 + skin);
      c += vec3(.06,.01,.015) * warmAmt * skin;

      // 五官與彩妝（需要人臉）
      if (maskOn > .5){
        vec3 mk = texture2D(mask, suv).rgb;
        vec3 m2 = texture2D(mask2, suv).rgb;
        float lipM = mk.b * (1.0 - mk.g);
        c = mix(c, (c - .45) * 1.3 + .54, mk.r * eyeBright);                 // 亮眼
        float yy = luma(c);
        float tw = mk.g * teethAmt * smoothstep(.30, .55, yy);                // 美牙
        c = mix(c, mix(vec3(yy), c, .35) * 1.1 + .04, tw);
        c = mix(c, vec3(.80,.18,.28) * (.45 + yy), lipM * lipAmt * .5);       // 唇色
        c = mix(c, blur * 1.10 + vec3(.03,.02,.01), m2.g * darkAmt * .9);     // 去黑眼圈
        c = mix(c, c * .85 + vec3(.22,.05,.08), m2.r * blushAmt * .7);        // 腮紅
        c += m2.b * hiAmt * .16 * vec3(1., .98, .95);                         // 立體高光
      }

      // 濾鏡
      if (filt > .5 && filt < 1.5){                 // 日系
        c = (c - .5) * .82 + .58;
        c *= vec3(.97,1.02,1.04);
        c = mix(vec3(luma(c)), c, .9);
      } else if (filt > 1.5 && filt < 2.5){         // 冷調
        c *= vec3(.92,1.0,1.1);
      } else if (filt > 2.5 && filt < 3.5){         // 粉嫩
        c = mix(c, vec3(1.0,.82,.88), .12);
        c = (c - .5) * .9 + .56;
        c *= vec3(1.03,.98,1.0);
      } else if (filt > 3.5){                       // 清透
        c = (c - .5) * .95 + .54;
        c = mix(vec3(luma(c)), c, 1.1);
        c *= vec3(.98,1.01,1.03);
      }

      // 畫質：亮度、對比、飽和度、暗角
      c += briAmt * .25;
      c = (c - .5) * (1.0 + conAmt * .6) + .5;
      c = mix(vec3(luma(c)), c, 1.0 + satAmt);
      float vg = smoothstep(.55, 1.15, length((uv - .5) * 1.45));
      c *= 1.0 - vg * vigAmt * .6;

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
  const mask2Tex = makeTexture(2);

  const U = (n) => gl.getUniformLocation(prog, n);
  const u = {
    mirror: U("mirror"), texel: U("texel"), asp: U("asp"),
    smooth: U("smoothAmt"), white: U("whiteAmt"), warm: U("warmAmt"), filt: U("filt"),
    eyeN: U("eyeN"), maskOn: U("maskOn"), eyeA: U("eyeA"),
    eyeBright: U("eyeBright"), teeth: U("teethAmt"), lip: U("lipAmt"),
    blush: U("blushAmt"), dark: U("darkAmt"), hi: U("hiAmt"),
    bri: U("briAmt"), con: U("conAmt"), sat: U("satAmt"), sharp: U("sharpAmt"), vig: U("vigAmt"),
  };
  gl.uniform1i(U("tex"), 0);
  gl.uniform1i(U("mask"), 1);
  gl.uniform1i(U("mask2"), 2);

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
      setStatus("人臉功能載入失敗（美膚、畫質與濾鏡仍可使用）");
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

  // 關鍵點索引（MediaPipe 468/478 點網格）
  const EYE_DEFS = [[468, 33, 133], [473, 362, 263]];         // [虹膜中心, 眼角1, 眼角2]
  const EYE_L = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246];
  const EYE_R = [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398];
  const MOUTH_IN = [78,95,88,178,87,14,317,402,318,324,308,415,310,311,312,13,82,81,80,191];
  const LIP_OUT = [61,146,91,181,84,17,314,405,321,375,291,409,270,269,267,0,37,39,40,185];

  // 兩張小畫布當遮罩貼圖。座標單位＝影像像素（用 setTransform 對應到畫布）
  const MS = 384;
  const mkCanvas = () => { const c = document.createElement("canvas"); c.width = c.height = MS; return c; };
  const maskCanvas = mkCanvas(), mask2Canvas = mkCanvas();
  const mctx = maskCanvas.getContext("2d"), m2ctx = mask2Canvas.getContext("2d");

  function poly(c, a, idx, color, W, H) {
    c.fillStyle = color; c.beginPath();
    idx.forEach((i, n) => {
      const x = a[2*i] * W, y = a[2*i+1] * H;
      n ? c.lineTo(x, y) : c.moveTo(x, y);
    });
    c.closePath(); c.fill();
  }
  // 柔邊橢圓（可旋轉），rgb 例如 "255,0,0"
  function blob(c, cx, cy, rx, ry, rot, rgb, alpha = 1) {
    c.save();
    c.translate(cx, cy); c.rotate(rot); c.scale(rx, ry);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(${rgb},${alpha})`);
    g.addColorStop(0.5, `rgba(${rgb},${alpha * 0.55})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

  // 腮紅、黑眼圈、立體高光的位置（跟著臉的傾斜角度旋轉）
  function drawBlobs(a, W, H) {
    const P = (i) => [a[2*i] * W, a[2*i+1] * H];
    const top = P(168), chin = P(152);
    const len = dist(top, chin) || 1;
    const ax = [(chin[0] - top[0]) / len, (chin[1] - top[1]) / len];
    const rot = Math.atan2(ax[1], ax[0]) - Math.PI / 2;
    const fw = dist(P(234), P(454));

    for (const [i, j] of [[50, 205], [280, 425]]) {               // 腮紅（R）
      const c = mid(P(i), P(j));
      blob(m2ctx, c[0], c[1], fw * 0.13, fw * 0.09, rot, "255,0,0");
    }
    for (const [lid, c1, c2] of [[145, 33, 133], [374, 362, 263]]) { // 黑眼圈（G）：下眼瞼下方
      const w = dist(P(c1), P(c2)), l = P(lid);
      blob(m2ctx, l[0] + ax[0] * w * 0.35, l[1] + ax[1] * w * 0.35, w * 0.65, w * 0.38, rot, "0,255,0");
    }
    const nb = lerp(top, P(1), 0.5);                              // 高光（B）：鼻樑、額頭、下巴尖
    blob(m2ctx, nb[0], nb[1], fw * 0.045, dist(top, P(1)) * 0.5, rot, "0,0,255");
    const fh = P(151);
    blob(m2ctx, fh[0], fh[1], fw * 0.14, fw * 0.07, rot, "0,0,255", 0.6);
    const cp = P(152);
    blob(m2ctx, cp[0] - ax[0] * fw * 0.06, cp[1] - ax[1] * fw * 0.06, fw * 0.09, fw * 0.05, rot, "0,0,255", 0.6);
  }

  function drawMask(W, H) {
    for (const c of [mctx, m2ctx]) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = "source-over";
      c.fillStyle = "#000"; c.fillRect(0, 0, MS, MS);
      c.globalCompositeOperation = "lighter";
      c.setTransform(MS / W, 0, 0, MS / H, 0, 0);
    }
    for (const a of faces.slice(0, 2)) {
      poly(mctx, a, EYE_L, "#f00", W, H); poly(mctx, a, EYE_R, "#f00", W, H);
      poly(mctx, a, MOUTH_IN, "#0f0", W, H); poly(mctx, a, LIP_OUT, "#00f", W, H);
      drawBlobs(a, W, H);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, mask2Tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask2Canvas);
    gl.activeTexture(gl.TEXTURE0);
  }

  // 把關鍵點轉成 shader 要的參數（變形座標單位＝影像高度）
  function uploadFaceUniforms(W, H) {
    const big = val("eye"), mouthS = val("mouth");
    const nf = Math.min(faces.length, 2);
    const eyes = new Float32Array(24);
    let ei = 0;

    for (let f = 0; f < nf; f++) {
      const a = faces[f];
      const P = (i) => [a[2*i] * W, a[2*i+1] * H];
      for (const [ir, c1, c2] of EYE_DEFS) {                      // 大眼
        const p1 = P(c1), p2 = P(c2);
        const C = a.length / 2 > ir ? P(ir) : mid(p1, p2);
        eyes.set([C[0] / H, C[1] / H, dist(p1, p2) * 0.8 / H, big * 0.5], ei); ei += 4;
      }
      const m1 = P(61), m2 = P(291);                              // 嘴型：正＝放大、負＝縮小
      const mc = mid(m1, m2);
      eyes.set([mc[0] / H, mc[1] / H, dist(m1, m2) * 0.6 / H, mouthS * 0.3], ei); ei += 4;
    }
    gl.uniform4fv(u.eyeA, eyes);
    gl.uniform1f(u.eyeN, (big > 0 || mouthS !== 0) ? nf * 3 : 0);
    gl.uniform1f(u.maskOn, nf > 0 ? 1 : 0);
    gl.uniform1f(u.eyeBright, val("bright"));
    gl.uniform1f(u.teeth, val("teeth"));
    gl.uniform1f(u.lip, val("lip"));
    gl.uniform1f(u.blush, val("blush"));
    gl.uniform1f(u.dark, val("dark"));
    gl.uniform1f(u.hi, val("hi"));
    if (nf > 0) drawMask(W, H);
  }

  // ---------- 九宮格輔助線 ----------
  function placeGrid() {
    const s = stage.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    Object.assign(grid.style, {
      left: (c.left - s.left) + "px", top: (c.top - s.top) + "px",
      width: c.width + "px", height: c.height + "px",
    });
  }
  $("gridbtn").onclick = () => {
    grid.hidden = !grid.hidden;
    $("gridbtn").classList.toggle("on", !grid.hidden);
    if (!grid.hidden) placeGrid();
  };
  window.addEventListener("resize", () => { if (!grid.hidden) placeGrid(); });

  // ---------- 繪製迴圈 ----------
  function render() {
    if (!running) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const w = video.videoWidth, h = video.videoHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h);
        if (!grid.hidden) placeGrid();
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
      gl.uniform1f(u.bri, val("bri"));
      gl.uniform1f(u.con, val("con"));
      gl.uniform1f(u.sat, val("sat"));
      gl.uniform1f(u.sharp, val("sharp"));
      gl.uniform1f(u.vig, val("vig"));
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
      const perm = e && ["NotAllowedError", "NotFoundError", "NotReadableError", "SecurityError"].includes(e.name);
      msg.textContent = perm
        ? "無法開啟相機：請允許相機權限，並確認網址是 https。"
        : "程式發生錯誤（" + (e && e.message) + "）。請強制重新整理，並確認所有檔案都已更新。";
      console.error(e);
    }
  }
  function stopCamera() {
    running = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  // ---------- 分頁、濾鏡與美顏模式 ----------
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
      document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("on", p.id === "tab-" + b.dataset.tab));
    };
  });

  function setFilter(i) {
    filterId = i;
    [...$("filters").children].forEach((x, n) => x.classList.toggle("on", n === i));
  }
  FILTERS.forEach((name, i) => {
    const b = document.createElement("button");
    b.textContent = name;
    b.onclick = () => setFilter(i);
    $("filters").appendChild(b);
  });
  setFilter(0);

  Object.entries(PRESETS).forEach(([name, p]) => {
    const b = document.createElement("button");
    b.textContent = name;
    b.onclick = () => {
      for (const [id, v] of Object.entries(p.v)) { const el = $(id); if (el) el.value = v; }
      setFilter(p.filter);
    };
    $("presets").appendChild(b);
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
