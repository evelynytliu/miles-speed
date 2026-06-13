/* vision.js — 鏡頭擷取、AI 骨架偵測（MoveNet）、移動色塊追蹤、每格回呼 */
const Vision = (function () {
  let video, canvas, ctx;
  let stream = null, running = false, busy = false;
  let detector = null;
  let mode = 'idle';            // 'pose' | 'motion' | 'idle'
  let onFrame = null;           // ({ctx,w,h,point,valid,extra}) => void
  let lastTime = 0;

  // 移動偵測用的縮圖
  const small = document.createElement('canvas');
  small.width = 192; small.height = 108;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  let prevGray = null;
  let motionThreshold = 28;     // 像素差門檻（越小越敏感）

  // 錄影（錄的是「影像 + 骨架/線/速度」的合成畫面）
  let recorder = null, recChunks = [], recStream = null, recMime = '', recording = false;
  let recCanvas = null, recCtx = null;
  let hud = { speed: '' };

  function init(v, c) {
    video = v; canvas = c; ctx = canvas.getContext('2d');
  }

  async function start() {
    if (stream) return true;
    const tryConstraints = [
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: 'environment' }, audio: false },
      { video: true, audio: false }
    ];
    let err;
    for (const c of tryConstraints) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; }
      catch (e) { err = e; }
    }
    if (!stream) throw err || new Error('no camera');
    video.srcObject = stream;
    await video.play().catch(() => {});
    await waitForVideo();
    sizeCanvas();
    running = true;
    requestAnimationFrame(loop);
    return true;
  }

  function waitForVideo() {
    return new Promise(res => {
      if (video.videoWidth) return res();
      video.onloadedmetadata = () => res();
      setTimeout(res, 2500);
    });
  }

  function sizeCanvas() {
    if (video.videoWidth && canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
  }

  function stop() {
    running = false;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function setMode(m) { mode = m; prevGray = null; }
  function setOnFrame(fn) { onFrame = fn; }
  function setSensitivity(v) { motionThreshold = v; }
  function isLive() { return running && !!stream; }
  function hasPose() { return !!detector; }

  async function ensurePose() {
    if (detector) return true;
    if (!window.poseDetection) throw new Error('pose lib missing');
    if (window.tf && tf.setBackend) { try { await tf.setBackend('webgl'); await tf.ready(); } catch (e) {} }
    detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
    );
    return true;
  }

  function byName(kp, name) { return kp.find(k => k.name === name); }
  function avg(arr, key) { return arr.reduce((s, p) => s + p[key], 0) / arr.length; }

  async function loop(ts) {
    if (!running) return;
    sizeCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let point = null, valid = false, extra = {};
    const now = performance.now();

    if (mode === 'pose' && detector && !busy && video.videoWidth) {
      busy = true;
      try {
        const poses = await detector.estimatePoses(video, { maxPoses: 1, flipHorizontal: false });
        if (poses && poses[0]) {
          extra.pose = poses[0];
          const kp = poses[0].keypoints;
          const lh = byName(kp, 'left_hip'), rh = byName(kp, 'right_hip');
          const hips = [lh, rh].filter(p => p && p.score > 0.3);
          if (hips.length) { point = { x: avg(hips, 'x'), y: avg(hips, 'y') }; valid = true; }
        }
      } catch (e) {}
      busy = false;
    } else if (mode === 'motion' && video.videoWidth) {
      const m = motionCentroid();
      if (m) {
        extra.motion = m;                    // 一定帶 profile（光閘判定用）
        if (m.count >= 12 && m.box) { point = { x: m.x, y: m.y }; valid = true; }
      }
    }

    if (onFrame) onFrame({ ctx, w: canvas.width, h: canvas.height, point, valid, extra, dt: (now - lastTime) / 1000 });
    lastTime = now;
    requestAnimationFrame(loop);
  }

  // ---------- 錄影（直接錄相機串流，不在每格合成，避免拖慢偵測）----------
  function pickMime() {
    const cands = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    if (!window.MediaRecorder) return '';
    for (const m of cands) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {} }
    return '';
  }
  function startRecording() {
    if (!stream || !window.MediaRecorder) return false;
    recMime = pickMime();
    try { recorder = new MediaRecorder(stream, recMime ? { mimeType: recMime, videoBitsPerSecond: 6000000 } : undefined); }
    catch (e) { try { recorder = new MediaRecorder(stream); } catch (e2) { return false; } }
    recChunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
    recording = true;
    try { recorder.start(); } catch (e) { recording = false; return false; }
    return true;
  }
  function stopRecording() {
    return new Promise(res => {
      if (!recorder || recorder.state === 'inactive') { recording = false; return res(null); }
      recorder.onstop = () => {
        recording = false;
        const type = recMime || 'video/webm';
        res(recChunks.length ? new Blob(recChunks, { type }) : null);
      };
      try { recorder.stop(); } catch (e) { recording = false; res(null); }
    });
  }
  function isRecording() { return recording; }
  function setHud(h) { hud = h || { speed: '' }; }
  function recExt() { return (recMime || '').indexOf('mp4') >= 0 ? 'mp4' : 'webm'; }

  // 估計全域位移：找出讓兩張投影最吻合的平移量（補償手持晃動/平移）
  function bestShift(cur, prev, M) {
    let best = 0, bestErr = Infinity, err0 = Infinity;
    const L = cur.length;
    for (let s = -M; s <= M; s++) {
      let err = 0, cnt = 0;
      for (let i = 0; i < L; i++) {
        const j = i - s;
        if (j < 0 || j >= L) continue;
        err += Math.abs(cur[i] - prev[j]); cnt++;
      }
      err /= (cnt || 1);
      if (s === 0) err0 = err;
      if (err < bestErr) { bestErr = err; best = s; }
    }
    // 只有當「平移」明顯比「不平移」吻合很多，才視為相機晃動而補償；
    // 否則（例如只有一顆球在動的靜止畫面）保持 0，避免把移動物體當成全域位移消掉
    if (bestErr > err0 * 0.85) return 0;
    return best;
  }

  // 影格相減（先補償全域晃動）：回傳移動中心、外框、橫向移動剖面、覆蓋率
  const PROF = 64;
  const SHIFT_X = 8, SHIFT_Y = 6;
  function motionCentroid() {
    sctx.drawImage(video, 0, 0, small.width, small.height);
    const img = sctx.getImageData(0, 0, small.width, small.height).data;
    const W = small.width, H = small.height, n = W * H;
    const gray = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      gray[i] = (img[i * 4] * 0.3 + img[i * 4 + 1] * 0.59 + img[i * 4 + 2] * 0.11) | 0;
    }
    if (!prevGray) { prevGray = gray; return null; }

    // 用行/列投影估計整張畫面平移了多少（= 相機晃動），等下扣掉
    const colG = new Float64Array(W), colP = new Float64Array(W);
    const rowG = new Float64Array(H), rowP = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, g = gray[i], p = prevGray[i];
        colG[x] += g; colP[x] += p; rowG[y] += g; rowP[y] += p;
      }
    }
    const dx = bestShift(colG, colP, SHIFT_X);
    const dy = bestShift(rowG, rowP, SHIFT_Y);

    // 穩定度：整張畫面（投影）相對前一格變化多少（相機晃動會很大；只有球在動則很小）
    let sumCol = 0, errX = 0, sumRow = 0, errY = 0;
    for (let x = 0; x < W; x++) { sumCol += colG[x]; errX += Math.abs(colG[x] - colP[x]); }
    for (let y = 0; y < H; y++) { sumRow += rowG[y]; errY += Math.abs(rowG[y] - rowP[y]); }
    const rx = (errX / W) / (sumCol / W + 1);
    const ry = (errY / H) / (sumRow / H + 1);
    const shake = Math.max(rx, ry);

    let sx = 0, sy = 0, count = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    const profile = new Array(PROF).fill(0);
    const pScale = PROF / W;
    // 補償晃動後比對：gray[x,y] 對到 prevGray[x-dx, y-dy]
    for (let y = 0; y < H; y++) {
      const py = y - dy; if (py < 0 || py >= H) continue;
      for (let x = 0; x < W; x++) {
        const px = x - dx; if (px < 0 || px >= W) continue;
        if (Math.abs(gray[y * W + x] - prevGray[py * W + px]) > motionThreshold) {
          sx += x; sy += y; count++;
          profile[(x * pScale) | 0]++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    prevGray = gray;
    const scaleX = canvas.width / W, scaleY = canvas.height / H;
    const out = { x: 0, y: 0, count, coverage: count / n, shift: { dx, dy }, shake, box: null, profile };
    // count 很低＝畫面幾乎沒動（穩定），仍回傳物件讓穩定度指示器能顯示
    if (count < 3) return out;
    if (count >= 8) {
      out.x = (sx / count) * scaleX;
      out.y = (sy / count) * scaleY;
      out.box = { x: minX * scaleX, y: minY * scaleY, w: (maxX - minX) * scaleX, h: (maxY - minY) * scaleY };
    }
    return out;
  }

  // 骨架連線（給跑步畫面用）
  const EDGES = [
    ['left_shoulder', 'right_shoulder'], ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
    ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
    ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'], ['left_hip', 'right_hip'],
    ['left_hip', 'left_knee'], ['left_knee', 'left_ankle'],
    ['right_hip', 'right_knee'], ['right_knee', 'right_ankle']
  ];
  function drawSkeleton(c, pose, color) {
    if (!pose) return;
    const kp = pose.keypoints, map = {};
    kp.forEach(k => map[k.name] = k);
    c.lineWidth = Math.max(3, c.canvas.width / 200);
    c.strokeStyle = color; c.fillStyle = color;
    EDGES.forEach(([a, b]) => {
      const p = map[a], q = map[b];
      if (p && q && p.score > 0.3 && q.score > 0.3) {
        c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(q.x, q.y); c.stroke();
      }
    });
    kp.forEach(k => {
      if (k.score > 0.3) { c.beginPath(); c.arc(k.x, k.y, c.lineWidth * 1.3, 0, 7); c.fill(); }
    });
  }

  return { init, start, stop, setMode, setOnFrame, setSensitivity, ensurePose, isLive, hasPose, drawSkeleton,
    startRecording, stopRecording, isRecording, setHud, recExt };
})();
