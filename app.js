/* app.js — 導覽、計時門、三模式邏輯、紀錄、語音、慶祝 */
(function () {
  const $ = s => document.querySelector(s);
  const video = $('#cam'), overlay = $('#overlay');
  const statusEl = $('#status'), liveEl = $('#liveSpeed');
  const panel = $('#panel'), resultEl = $('#result');
  const camCover = $('#camCover'), coverText = $('#coverText'), coverEmoji = $('#coverEmoji');
  const countdownEl = $('#countdown');
  const tapCatcher = $('#tapCatcher'), tapText = $('#tapText');

  Vision.init(video, overlay);

  // ---------- 狀態 ----------
  const state = {
    mode: 'run',
    distance: 5,          // 兩條線之間的實際距離（公尺）
    gateA: 0.30,          // 起點線（畫面寬度比例）
    gateB: 0.70,          // 終點線
    phase: 'idle',        // idle | armed | timing | done
    t1: 0, firstIsA: true, prevFrac: null, prevFracTime: 0,
    counting: false, cdTimer: null,
    record: true,
    overlayLog: [], recStart: 0, lastLog: [],
    stripMin: 18, flash: null, armAt: 0,
    kickMode: 'manual',   // 'manual' = 點按計時（手持也準）；'auto' = 自動偵測（需放穩）
    liveSpeed: 0,
    onMeasure: null,      // (kmh, dt) => void
    visionMode: 'pose',
    accent: '#1d9e75',
  };

  // 模式設定
  const MODES = {
    run:  { vision: 'pose',   accent: '#1d9e75', emoji: '🏃', label: '跑步', distance: 5 },
    race: { vision: 'pose',   accent: '#d85a30', emoji: '🚩', label: '比賽', distance: 5 },
    kick: { vision: 'motion', accent: '#ba7517', emoji: '⚽️', label: '踢球', distance: 4 },
  };

  // ---------- 語音鼓勵 ----------
  let voices = [];
  function loadVoices() { voices = window.speechSynthesis ? speechSynthesis.getVoices() : []; }
  if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
  function speak(text) {
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-TW'; u.rate = 1.02; u.pitch = 1.1;
    const v = voices.find(v => /zh|Chinese|Mandarin/i.test(v.lang + v.name));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }

  // ---------- 紀錄（localStorage）----------
  const KEY = 'miles_speed_records';
  function getRecords() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function saveRecords(r) { localStorage.setItem(KEY, JSON.stringify(r)); }
  function checkBest(mode, kmh) {
    const r = getRecords();
    if (!r[mode] || kmh > r[mode].kmh) { r[mode] = { kmh, ts: Date.now() }; saveRecords(r); return true; }
    return false;
  }

  // ---------- 計時門偵測 ----------
  const HOLD_MS = 320;   // 短暫偵測不到時，保留上一個位置多久（解決相機/畫面更新不同步）

  function arm() {
    state.phase = 'armed'; state.t1 = 0; state.prevFrac = null; state.prevFracTime = 0;
    state.armAt = performance.now(); state._aPrev = false; state._bPrev = false;
    hideResult(); setStatus('就位…等待通過'); updateActionBtn();
    if (state.record && Vision.isLive() && !Vision.isRecording()) {
      if (Vision.startRecording()) { state.recStart = performance.now(); state.overlayLog = []; }
    }
  }
  function resetGate() { state.phase = 'idle'; state.prevFrac = null; updateActionBtn(); }

  function gateStep(frame) {
    const { point, valid, w } = frame;
    drawScene(frame);
    const now = performance.now();

    // 踢球：用「光閘」判定（只看起終點線上的移動量），抗旁邊有人在動
    if (state.visionMode === 'motion') { motionGateStep(frame, now); return; }

    if (!valid || !point) {
      // 影格之間相機可能還沒更新 → 暫時保留上一個位置，超過 HOLD_MS 才清空
      if (state.prevFrac != null && now - state.prevFracTime > HOLD_MS) state.prevFrac = null;
      decayLive();
      // 計時太久沒到終點 → 重新就位
      if (state.phase === 'timing' && now - state.t1 > 8000) arm();
      return;
    }
    const frac = point.x / w;
    const p = state.prevFrac;
    const jump = p != null ? Math.abs(frac - p) : 0;

    // 即時速度（用校正比例換算）
    const span = Math.abs(state.gateB - state.gateA) * w || 1;
    const mPerPx = state.distance / span;
    if (p != null && jump < 0.5) {
      const ddt = (now - state.prevFracTime) / 1000;
      if (ddt > 0) {
        const inst = Math.abs(frac - p) * w * mPerPx / ddt * 3.6;
        if (inst < 90) { state.liveSpeed = state.liveSpeed * 0.6 + inst * 0.4; updateLive(); }
      }
    }

    // 過線判定（忽略瞬間大跳動，避免雜訊/畫面回捲誤觸）
    if ((state.phase === 'armed' || state.phase === 'timing') && p != null && jump < 0.5) {
      const crossA = (p - state.gateA) * (frac - state.gateA) < 0;
      const crossB = (p - state.gateB) * (frac - state.gateB) < 0;
      if (state.phase === 'armed' && (crossA || crossB)) {
        state.phase = 'timing'; state.t1 = now;
        state.firstIsA = crossA;        // 從哪條線起跑就往另一條算
        setStatus('計時中… 衝啊！'); updateActionBtn();
      } else if (state.phase === 'timing') {
        const finished = state.firstIsA ? crossB : crossA;
        if (finished) {
          const sec = (now - state.t1) / 1000;
          if (sec > 0.06) { state.phase = 'done'; complete(sec); }
        }
      }
    }
    state.prevFrac = frac;
    state.prevFracTime = now;
  }

  // 光閘（抗手持晃動版）：只在「某條線上的移動明顯突出於畫面平均」時才算有東西通過
  const STRIP_HALF = 0.06;    // 線兩側各取 6% 寬當感應帶
  const ARM_GRACE = 800;      // 按下後先給 0.8 秒穩住手機，不判定
  const PEAK_RATIO = 2.4;     // 線上移動量要比畫面平均突出這麼多倍
  const BUSY_COVER = 0.30;    // 整個畫面動超過 30% = 大晃動/平移 → 暫停判定
  function motionAt(profile, frac) {
    if (!profile) return 0;
    const n = profile.length;
    const lo = Math.max(0, Math.floor((frac - STRIP_HALF) * n));
    const hi = Math.min(n - 1, Math.ceil((frac + STRIP_HALF) * n));
    let s = 0; for (let i = lo; i <= hi; i++) s += profile[i];
    return s;
  }
  function motionGateStep(frame, now) {
    const m = frame.extra.motion;
    const prof = m ? m.profile : null;
    if (!prof) { liveEl.innerHTML = '<small>對準球的路線</small>'; state._aPrev = false; state._bPrev = false; return; }

    const PROF = prof.length;
    const busy = (m.coverage || 0) > BUSY_COVER;              // 防線 2：大晃動暫停
    const avgBucket = m.count / PROF;
    const nStrip = Math.max(1, Math.round(STRIP_HALF * 2 * PROF));
    const TH = state.stripMin;
    // 防線 1：線上移動量要「突出」於畫面平均，才算真的有東西通過（手晃是均勻的，會被擋掉）
    const aSum = motionAt(prof, state.gateA), bSum = motionAt(prof, state.gateB);
    const aActive = !busy && aSum >= TH && (aSum / nStrip) >= PEAK_RATIO * avgBucket;
    const bActive = !busy && bSum >= TH && (bSum / nStrip) >= PEAK_RATIO * avgBucket;

    // 即時回饋
    liveEl.innerHTML = busy ? '<span style="color:var(--bad)">✋ 拿穩一點</span>'
      : (aActive || bActive) ? '<span style="color:var(--accent)">● 偵測到</span>'
      : '<small>對準球的路線</small>';

    const armedOrTiming = state.phase === 'armed' || state.phase === 'timing';
    const grace = now - state.armAt < ARM_GRACE;             // 防線 3：剛按下不判定
    if (!armedOrTiming || grace) { state._aPrev = aActive; state._bPrev = bActive; return; }

    const aRise = aActive && !state._aPrev;                  // 局部移動「剛出現」在這條線
    const bRise = bActive && !state._bPrev;
    state._aPrev = aActive; state._bPrev = bActive;

    if (state.phase === 'armed') {
      if (aRise || bRise) {
        state.phase = 'timing'; state.t1 = now;
        state.firstIsA = aRise && !bRise ? true : (bRise && !aRise ? false : true);
        flashGate(state.firstIsA ? state.gateA : state.gateB);
        if (navigator.vibrate) navigator.vibrate(20);
        setStatus('偵測到！計時中…'); updateActionBtn();
      }
    } else if (state.phase === 'timing') {
      const finished = state.firstIsA ? bRise : aRise;
      if (finished) {
        const sec = (now - state.t1) / 1000;
        if (sec >= 0.05 && sec <= 1.8) { flashGate(state.firstIsA ? state.gateB : state.gateA); state.phase = 'done'; complete(sec); }
        else if (sec > 1.8) { arm(); }   // 太慢，大概是誤觸，重新就位
      } else if (now - state.t1 > 4000) {
        arm();
      }
    }
  }
  function flashGate(frac) { state.flash = { frac, until: performance.now() + 220 }; }

  function decayLive() { state.liveSpeed *= 0.9; if (state.liveSpeed < 0.3) state.liveSpeed = 0; updateLive(); }
  function updateLive() {
    liveEl.innerHTML = state.liveSpeed.toFixed(1) + ' <small>km/h</small>';
    Vision.setHud({ speed: state.liveSpeed > 0.3 ? state.liveSpeed.toFixed(1) + ' km/h' : '' });
  }

  function complete(sec) {
    const kmh = state.distance / sec * 3.6;
    if (navigator.vibrate) navigator.vibrate(60);
    state.lastLog = state.overlayLog.slice();
    const finalize = (blob) => { if (state.onMeasure) state.onMeasure(kmh, sec, blob); updateActionBtn(); };
    if (Vision.isRecording()) Vision.stopRecording().then(finalize);
    else finalize(null);
  }

  // ---------- 開始 / 停止流程（主按鈕）----------
  function labelForMode() {
    if (state.mode === 'run') return '🏁 開始計時';
    if (state.mode === 'kick') return state.kickMode === 'manual' ? '👆 開始點按計時' : '⚽️ 準備踢球';
    if (state.mode === 'race') return '🏁 ' + race.players[race.cur].name + ' 開始';
    return '開始';
  }
  function isActive() {
    return state.counting || ['armed', 'timing', 'manual1', 'manual2'].indexOf(state.phase) >= 0;
  }
  function updateActionBtn() {
    const b = document.querySelector('#goBtn'); if (!b) return;
    if (isActive()) { b.textContent = '■ 停止／重來'; b.classList.add('stop'); b.onclick = stopFlow; }
    else { b.textContent = labelForMode(); b.classList.remove('stop'); b.onclick = startFlow; }
  }
  async function startFlow() {
    const manualKick = state.mode === 'kick' && state.kickMode === 'manual';
    if (!Vision.isLive()) { await openCamera(); if (!Vision.isLive() && !manualKick) return; }
    hideResult();
    if (manualKick) { startManual(); return; }
    if (state.mode === 'kick') { arm(); setStatus('就位…踢出球吧！'); return; }
    // 跑步 / 比賽：倒數後就位
    state.counting = true; updateActionBtn();
    countdown(3, () => { state.counting = false; arm(); });
  }
  function manualEntry() { if (!Vision.isLive()) openCamera().then(startManual); else startManual(); }
  function stopFlow() {
    state.counting = false;
    if (state.cdTimer) { clearTimeout(state.cdTimer); state.cdTimer = null; }
    countdownEl.hidden = true;
    hideTap();
    if (Vision.isRecording()) Vision.stopRecording();   // 取消這次錄影
    resetGate();
    state.liveSpeed = 0; updateLive();
    setStatus('已就緒，按開始');
  }

  // ---------- 手動點按計時（手持也準：球過一條線點一下、過另一條再點）----------
  function startManual() {
    hideResult();
    state.phase = 'manual1'; state.armAt = performance.now();
    if (state.record && Vision.isLive() && !Vision.isRecording()) {
      if (Vision.startRecording()) { state.recStart = performance.now(); state.overlayLog = []; }
    }
    updateActionBtn();
    showTap('① 球過綠線時點一下');
    setStatus('球過綠線時點畫面');
  }
  function showTap(txt) { tapText.textContent = txt; tapCatcher.hidden = false; }
  function hideTap() { tapCatcher.hidden = true; }
  function onTap() {
    const now = performance.now();
    if (state.phase === 'manual1') {
      if (now - state.armAt < 150) return;
      state.t1 = now; flashGate(state.gateA);
      if (navigator.vibrate) navigator.vibrate(25);
      state.phase = 'manual2'; showTap('② 球過紅線時再點一下'); setStatus('計時中…');
    } else if (state.phase === 'manual2') {
      const sec = (now - state.t1) / 1000;
      if (sec < 0.05) return;
      flashGate(state.gateB); hideTap(); state.phase = 'done'; complete(sec);
    }
  }
  tapCatcher.onclick = onTap;

  // ---------- 畫面繪製（線、追蹤點、骨架）----------
  function drawScene(frame) {
    const { ctx, w, h, point, extra } = frame;
    const d = {
      gateA: state.gateA, gateB: state.gateB,
      point: point ? { x: point.x, y: point.y } : null,
      pose: (state.visionMode === 'pose' && extra.pose) ? extra.pose : null,
      box: (state.visionMode === 'motion' && extra.motion) ? extra.motion.box : null
    };
    paintOverlay(ctx, w, h, d, state.accent, '');   // 即時畫面不燒速度（用 DOM 速度牌）
    // 光閘觸發時，線閃一下白光當回饋
    if (state.flash && performance.now() < state.flash.until) {
      const x = state.flash.frac * w;
      ctx.fillStyle = 'rgba(255,255,255,.45)';
      ctx.fillRect(x - w * STRIP_HALF, 0, w * STRIP_HALF * 2, h);
    }
    if (state.record && Vision.isRecording()) pushSnapshot(d, w);
  }

  // 純繪圖：即時畫面與「事後特效合成」共用同一套，確保一致
  function paintOverlay(ctx, w, h, d, accent, burnSpeed) {
    line(ctx, d.gateA * w, h, '#5dcaa5', '起點');
    line(ctx, d.gateB * w, h, '#f09595', '終點');
    if (d.pose) Vision.drawSkeleton(ctx, d.pose, accent);
    if (d.box) {
      ctx.strokeStyle = accent; ctx.lineWidth = Math.max(3, w / 220);
      ctx.strokeRect(d.box.x - 6, d.box.y - 6, d.box.w + 12, d.box.h + 12);
    }
    if (d.point) {
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(d.point.x, d.point.y, Math.max(7, w / 90), 0, 7); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(d.point.x, d.point.y, Math.max(3, w / 200), 0, 7); ctx.fill();
    }
    if (burnSpeed) {
      const f = Math.max(20, w / 28);
      ctx.font = `600 ${f}px sans-serif`; ctx.textAlign = 'right';
      const tw = ctx.measureText(burnSpeed).width;
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(w - tw - 36, 14, tw + 26, f + 16);
      ctx.fillStyle = '#fff'; ctx.fillText(burnSpeed, w - 24, 14 + f + 1);
      ctx.textAlign = 'left';
    }
  }

  // 錄影時記錄每格的疊圖資料（很小，純數字）供事後合成特效版
  function pushSnapshot(d, w) {
    if (state.overlayLog.length > 900) return;
    state.overlayLog.push({
      t: performance.now() - state.recStart,
      gateA: d.gateA, gateB: d.gateB,
      point: d.point ? { x: d.point.x, y: d.point.y } : null,
      pose: d.pose ? { keypoints: d.pose.keypoints.map(k => ({ name: k.name, x: k.x, y: k.y, score: k.score })) } : null,
      box: d.box ? { x: d.box.x, y: d.box.y, w: d.box.w, h: d.box.h } : null,
      speed: state.liveSpeed > 0.3 ? state.liveSpeed.toFixed(1) + ' km/h' : ''
    });
  }
  function line(ctx, x, h, color, text) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(3, ctx.canvas.width / 240);
    ctx.setLineDash([14, 10]); ctx.beginPath();
    ctx.moveTo(x, 8); ctx.lineTo(x - 14, h - 8); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.font = `600 ${Math.max(16, ctx.canvas.width / 36)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.fillText(text, x, 30);
  }

  function setStatus(t) { statusEl.textContent = t; }

  // ---------- 拖曳調整起點/終點線 ----------
  let dragging = null;
  function fracFromEvent(e) {
    const r = overlay.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    return Math.min(0.95, Math.max(0.05, x / r.width));
  }
  function onDown(e) {
    const f = fracFromEvent(e);
    dragging = Math.abs(f - state.gateA) < Math.abs(f - state.gateB) ? 'A' : 'B';
    onMove(e);
  }
  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    const f = fracFromEvent(e);
    if (dragging === 'A') state.gateA = Math.min(f, state.gateB - 0.05);
    else state.gateB = Math.max(f, state.gateA + 0.05);
  }
  function onUp() { dragging = null; }
  overlay.addEventListener('pointerdown', onDown);
  overlay.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  // ---------- 結果 / 慶祝 ----------
  function hideResult() { resultEl.hidden = true; resultEl.innerHTML = ''; }
  function showResult(html) { resultEl.hidden = false; resultEl.innerHTML = html; }

  function gauge(kmh, accent) {
    const pct = Math.min(kmh / 30, 1), off = 251 - 251 * pct;
    return `<svg viewBox="0 0 200 118" width="190">
      <path d="M20 108 A80 80 0 0 1 180 108" fill="none" stroke="${accent}33" stroke-width="14" stroke-linecap="round"/>
      <path d="M20 108 A80 80 0 0 1 180 108" fill="none" stroke="${accent}" stroke-width="14" stroke-linecap="round" stroke-dasharray="251" stroke-dashoffset="${off}"/>
    </svg>`;
  }

  const RUN_CHEERS = ['哇！你像一隻小獵豹！', '太快了吧！再來一次！', '咻──超快的！', '你是閃電俠嗎？', '厲害！腳步好快！'];
  const KICK_CHEERS = ['好強的一腳！', '咻！這球飛超遠！', '射門！好厲害！', '這一腳超有力！'];

  function celebrate(kmh, best, mode, blob) {
    const accent = state.accent;
    const cheers = mode === 'kick' ? KICK_CHEERS : RUN_CHEERS;
    const cheer = cheers[Math.floor(performance.now() / 137) % cheers.length];
    showResult(`<div class="result-card pop">
      ${gauge(kmh, accent)}
      <div class="result-big">${kmh.toFixed(1)} <small>km/h</small></div>
      <div class="result-sub">${mode === 'kick' ? '球速' : '速度'} · 約 ${(kmh / 3.6).toFixed(1)} 公尺/秒</div>
      ${best ? '<div class="bestbadge">🎉 破紀錄！</div>' : ''}
      <div class="result-cheer">📣 「${cheer}」</div>
      <div class="replay-slot"></div>
    </div>`);
    if (best) confetti();
    speak((best ? '破紀錄了！' : '') + cheer + ' 時速' + kmh.toFixed(0) + '公里');
    attachReplay(blob, mode, kmh);
  }

  // ---------- 重播 + 存到手機（特效版 / 原始版）----------
  let lastClipUrl = null, lastFxUrl = null;
  function attachReplay(blob, mode, kmh) {
    const slot = resultEl.querySelector('.replay-slot');
    if (!slot) return;
    if (!blob) {
      if (state.record && Vision.isLive())
        slot.innerHTML = '<p class="replay-note">這次沒錄到影片（瀏覽器可能不支援錄影）。</p>';
      return;
    }
    if (lastClipUrl) URL.revokeObjectURL(lastClipUrl);
    if (lastFxUrl) { URL.revokeObjectURL(lastFxUrl); lastFxUrl = null; }
    lastClipUrl = URL.createObjectURL(blob);
    const log = state.lastLog || [];
    const accent = state.accent;
    const base = `speed-${mode}-${kmh.toFixed(0)}kmh`;
    slot.innerHTML = `
      <video class="replay-video" src="${lastClipUrl}" playsinline muted loop autoplay controls></video>
      <div class="save-opts">
        <button class="big" id="saveFx">✨ 存特效版</button>
        <button class="secondary" id="saveRaw">💾 存原始版</button>
      </div>
      <p class="replay-note">特效版會把骨架、起終點線、速度做進影片（製作需幾秒）。原始版是乾淨的鏡頭畫面。</p>`;
    const vEl = slot.querySelector('.replay-video');
    slot.querySelector('#saveRaw').onclick = () => saveVideo(blob, base + '.' + Vision.recExt());
    let fxBlob = null;
    slot.querySelector('#saveFx').onclick = async () => {
      const btn = slot.querySelector('#saveFx');
      if (fxBlob) { saveVideo(fxBlob, base + '-fx.' +extFromMime(fxBlob.type)); return; }
      if (!log.length) { btn.textContent = '✨ 這次沒有特效資料'; return; }
      btn.disabled = true; btn.textContent = '✨ 製作中…';
      fxBlob = await renderEffectsClip(blob, log, accent);
      btn.disabled = false;
      if (!fxBlob) { btn.textContent = '✨ 特效製作失敗'; return; }
      btn.textContent = '✨ 存特效版';
      if (lastFxUrl) URL.revokeObjectURL(lastFxUrl);
      lastFxUrl = URL.createObjectURL(fxBlob);
      vEl.src = lastFxUrl; vEl.play();   // 預覽切到特效版
      saveVideo(fxBlob, base + '-fx.' +extFromMime(fxBlob.type));
    };
  }

  function extFromMime(t) { return t && t.indexOf('mp4') >= 0 ? 'mp4' : 'webm'; }
  function fxMime() {
    const c = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    if (!window.MediaRecorder) return '';
    for (const m of c) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {} }
    return '';
  }
  function nearestSnap(log, tMs) {
    if (!log.length) return null;
    let best = log[0], bd = Math.abs(log[0].t - tMs);
    for (let i = 1; i < log.length; i++) {
      const dd = Math.abs(log[i].t - tMs);
      if (dd < bd) { bd = dd; best = log[i]; }
      else if (log[i].t > tMs) break;
    }
    return best;
  }

  // 事後把疊圖合成進影片（用播放重新編碼，不影響即時偵測）
  function renderEffectsClip(cleanBlob, log, accent) {
    return new Promise((resolve) => {
      if (!window.MediaRecorder) return resolve(null);
      const url = URL.createObjectURL(cleanBlob);
      const v = document.createElement('video');
      v.src = url; v.muted = true; v.playsInline = true;
      let done = false;
      const fail = () => { if (!done) { done = true; URL.revokeObjectURL(url); resolve(null); } };
      v.onerror = fail;
      setTimeout(() => { if (!done) fail(); }, 30000);   // 安全逾時
      v.onloadedmetadata = () => {
        const W = v.videoWidth || 640, H = v.videoHeight || 360;
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        const cx = cv.getContext('2d');
        const stream = cv.captureStream(30);
        const mime = fxMime();
        let rec;
        try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6000000 } : undefined); }
        catch (e) { try { rec = new MediaRecorder(stream); } catch (e2) { return fail(); } }
        const chunks = [];
        rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = () => { if (done) return; done = true; URL.revokeObjectURL(url); resolve(chunks.length ? new Blob(chunks, { type: mime || 'video/webm' }) : null); };
        const paint = () => {
          cx.drawImage(v, 0, 0, W, H);
          const snap = nearestSnap(log, v.currentTime * 1000);
          if (snap) paintOverlay(cx, W, H, snap, accent, snap.speed || '');
        };
        const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
        let iv = null;
        const finish = () => { paint(); setTimeout(() => { try { rec.stop(); } catch (e) {} if (iv) clearInterval(iv); }, 120); };
        v.onended = finish;
        rec.start();
        v.play().then(() => {
          if (hasRVFC) {
            const step = () => { if (v.ended || v.paused) return; paint(); v.requestVideoFrameCallback(step); };
            v.requestVideoFrameCallback(step);
          } else {
            iv = setInterval(() => { if (v.ended) return; paint(); }, 33);
          }
        }).catch(fail);
      };
    });
  }

  async function saveVideo(blob, name) {
    const type = blob.type || 'video/webm';
    try {
      const file = new File([blob], name, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '速度王' });
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    // 後備：直接下載
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 15000);
  }

  // ---------- 五彩紙花 ----------
  function confetti() {
    const c = document.createElement('canvas');
    c.className = 'confetti'; c.width = innerWidth; c.height = innerHeight;
    document.body.appendChild(c);
    const cx = c.getContext('2d');
    const cols = ['#1d9e75', '#d85a30', '#ba7517', '#378add', '#d4537e', '#ef9f27'];
    const bits = Array.from({ length: 120 }, () => ({
      x: Math.random() * c.width, y: -20 - Math.random() * c.height * 0.5,
      r: 4 + Math.random() * 6, c: cols[(Math.random() * cols.length) | 0],
      vy: 2 + Math.random() * 4, vx: -2 + Math.random() * 4, rot: Math.random() * 6
    }));
    let frames = 0;
    (function anim() {
      cx.clearRect(0, 0, c.width, c.height);
      bits.forEach(b => {
        b.y += b.vy; b.x += b.vx; b.rot += 0.2;
        cx.save(); cx.translate(b.x, b.y); cx.rotate(b.rot);
        cx.fillStyle = b.c; cx.fillRect(-b.r / 2, -b.r / 2, b.r, b.r * 1.6); cx.restore();
      });
      if (frames++ < 150) requestAnimationFrame(anim); else c.remove();
    })();
  }

  function countdown(n, done) {
    countdownEl.hidden = false;
    (function tick() {
      if (!state.counting) { countdownEl.hidden = true; return; } // 已被停止
      if (n <= 0) { countdownEl.hidden = true; done(); return; }
      countdownEl.textContent = n; countdownEl.classList.remove('pop');
      void countdownEl.offsetWidth; countdownEl.classList.add('pop');
      if (navigator.vibrate) navigator.vibrate(30);
      n--; state.cdTimer = setTimeout(tick, 800);
    })();
  }

  // ====================================================================
  //  模式：跑步
  // ====================================================================
  function mountRun() {
    state.onMeasure = (kmh, sec, blob) => {
      const best = checkBest('run', kmh);
      celebrate(kmh, best, 'run', blob);
      setStatus('完成！按「再來一次」');
    };
    panel.innerHTML = distanceControl() + `
      <div class="btn-row">
        <button class="big" id="goBtn">🏁 開始計時</button>
        <button class="secondary" id="manualBtn">手動</button>
      </div>
      <p class="hint">手機架在<b>側面</b>，讓小朋友橫向跑過畫面。拖曳綠線/紅線對準起跑與終點。</p>
      ${recordToggle()}`;
    wireDistance(); wireRecord();
    updateActionBtn();
    $('#manualBtn').onclick = manualEntry;
  }

  // ====================================================================
  //  模式：比賽（兩位選手輪流跑同一段）
  // ====================================================================
  const PLAYERS_KEY = 'speed_players';
  function loadPlayers() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(PLAYERS_KEY)); } catch (e) {}
    const def = [{ name: '選手 1', emoji: '🟠' }, { name: '選手 2', emoji: '🔵' }];
    if (saved && saved[0] && saved[1]) { def[0].name = saved[0].name || def[0].name; def[1].name = saved[1].name || def[1].name; }
    return def;
  }
  function savePlayers() {
    localStorage.setItem(PLAYERS_KEY, JSON.stringify(race.players.map(p => ({ name: p.name }))));
  }
  function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function safeName(s) { return String(s).replace(/[\\/:*?"<>|\s]+/g, '') || 'player'; }
  const race = { players: loadPlayers(), cur: 0, results: [] };
  function mountRace() {
    race.cur = 0; race.results = []; state.phase = 'idle'; state.counting = false;
    state.onMeasure = (kmh, sec, blob) => {
      race.results[race.cur] = { kmh, sec, blob, log: state.lastLog.slice() };
      if (race.cur === 0) {
        speak(race.players[0].name + ' 跑了 ' + sec.toFixed(1) + ' 秒，換 ' + race.players[1].name);
        race.cur = 1; renderRace(); setStatus(race.players[1].name + ' 準備，按開始');
      } else {
        renderRace(); finishRace();
      }
    };
    renderRace();
  }
  function renderRace() {
    panel.innerHTML = `
      <div class="players">
        ${race.players.map((p, i) => `
          <div class="player ${i === race.cur ? 'active' : ''}">
            <div class="pname"><span>${p.emoji}</span><input class="name-input" data-i="${i}" value="${escapeAttr(p.name)}" maxlength="10" aria-label="選手${i + 1}名字" /></div>
            <div class="ptime">${race.results[i] ? race.results[i].sec.toFixed(2) : '--'}<small>s</small></div>
          </div>`).join('')}
      </div>
      <p class="hint" style="margin-top:0">點上面的名字可以改成你們自己的名字 ✏️</p>
      ${distanceControl()}
      <div class="btn-row">
        <button class="big" id="goBtn">🏁 ${race.players[race.cur].name} 開始</button>
        <button class="secondary" id="resetRace">重來</button>
      </div>
      <p class="hint">同一條跑道，兩人輪流跑。跑完自動換下一位，最後比出贏家！</p>
      ${recordToggle()}`;
    wireDistance(); wireRecord();
    state.phase = 'idle'; state.counting = false;
    updateActionBtn();
    panel.querySelectorAll('.name-input').forEach(inp => {
      inp.onchange = inp.oninput = () => {
        const i = +inp.dataset.i;
        race.players[i].name = inp.value.trim() || ('選手 ' + (i + 1));
        savePlayers();
        const b = $('#goBtn');
        if (b && !b.classList.contains('stop')) b.textContent = '🏁 ' + race.players[race.cur].name + ' 開始';
      };
    });
    $('#resetRace').onclick = () => { hideResult(); mountRace(); };
  }
  function finishRace() {
    const [a, b] = race.results;
    if (!a || !b) return;
    const winnerIdx = a.sec <= b.sec ? 0 : 1;
    const win = race.players[winnerIdx], diff = Math.abs(a.sec - b.sec);
    const maxKmh = Math.max(a.kmh, b.kmh);
    showResult(`<div class="result-card pop">
      <div class="result-emoji">🏆</div>
      <div style="font-size:24px;font-weight:800;color:${state.accent};margin-top:4px;">${win.emoji} ${win.name} 贏了！</div>
      <div class="result-sub">快了 ${diff.toFixed(2)} 秒 · 最高 ${maxKmh.toFixed(1)} km/h</div>
      <div class="replay" id="replay"></div>
      <div class="sbs-slot" id="sbsSlot"></div>
      <div class="race-clips" id="raceClips"></div>
    </div>`);
    animateReplay(a, b);
    attachSbs(a, b);
    attachRaceClips();
    confetti();
    speak(win.name + ' 贏了！快了 ' + diff.toFixed(1) + ' 秒');
  }
  function attachSbs(a, b) {
    const slot = $('#sbsSlot'); if (!slot) return;
    if (!a.blob || !b.blob) return;   // 有一邊沒錄到就不提供並排
    slot.innerHTML = `
      <button class="big" id="saveSbs">🏁 存並排對比影片（特效）</button>
      <p class="replay-note">把 ${race.players[0].name} 和 ${race.players[1].name} 兩段影片左右並排成一支對比影片（製作需幾秒）。</p>`;
    let sbsBlob = null;
    $('#saveSbs').onclick = async () => {
      const btn = $('#saveSbs');
      if (sbsBlob) { saveVideo(sbsBlob, `speed-race-sidebyside.${extFromMime(sbsBlob.type)}`); return; }
      btn.disabled = true; btn.textContent = '🏁 製作中…';
      const p0 = { blob: a.blob, log: a.log || [], name: race.players[0].name, emoji: race.players[0].emoji, sec: a.sec, kmh: a.kmh, accent: '#d85a30' };
      const p1 = { blob: b.blob, log: b.log || [], name: race.players[1].name, emoji: race.players[1].emoji, sec: b.sec, kmh: b.kmh, accent: '#378add' };
      sbsBlob = await renderSideBySideClip(p0, p1);
      btn.disabled = false;
      if (!sbsBlob) { btn.textContent = '🏁 製作失敗'; return; }
      btn.textContent = '🏁 存並排對比影片（特效）';
      let pv = slot.querySelector('.replay-video');
      if (!pv) {
        pv = document.createElement('video');
        pv.className = 'replay-video'; pv.playsInline = true; pv.muted = true; pv.loop = true; pv.autoplay = true; pv.controls = true;
        slot.insertBefore(pv, slot.firstChild);
      }
      pv.src = URL.createObjectURL(sbsBlob); pv.play();
      saveVideo(sbsBlob, `speed-race-sidebyside.${extFromMime(sbsBlob.type)}`);
    };
  }

  // 把兩段影片左右並排合成一支（事後背景處理）
  function mkVid(src) { const v = document.createElement('video'); v.src = src; v.muted = true; v.playsInline = true; return v; }
  function renderSideBySideClip(p0, p1) {
    return new Promise((resolve) => {
      if (!window.MediaRecorder) return resolve(null);
      const u0 = URL.createObjectURL(p0.blob), u1 = URL.createObjectURL(p1.blob);
      const v0 = mkVid(u0), v1 = mkVid(u1);
      let done = false, ready = 0, stopping = false, iv = null;
      const cleanup = () => { URL.revokeObjectURL(u0); URL.revokeObjectURL(u1); };
      const fail = () => { if (!done) { done = true; if (iv) clearInterval(iv); cleanup(); resolve(null); } };
      setTimeout(() => { if (!done) fail(); }, 45000);
      v0.onerror = fail; v1.onerror = fail;
      v0.onloadedmetadata = onMeta; v1.onloadedmetadata = onMeta;
      function onMeta() { if (++ready === 2) start(); }

      function start() {
        const cellW = 640, cellH = 360, W = cellW * 2, H = cellH;
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        const cx = cv.getContext('2d');
        const stream = cv.captureStream(30);
        const mime = fxMime();
        let rec;
        try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8000000 } : undefined); }
        catch (e) { try { rec = new MediaRecorder(stream); } catch (e2) { return fail(); } }
        const chunks = [];
        rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = () => { if (done) return; done = true; cleanup(); resolve(chunks.length ? new Blob(chunks, { type: mime || 'video/webm' }) : null); };
        const winner = p0.sec <= p1.sec ? 0 : 1;

        function drawCell(v, p, cellX, isWin) {
          cx.fillStyle = '#000'; cx.fillRect(cellX, 0, cellW, cellH);
          const vw = v.videoWidth || 640, vh = v.videoHeight || 360;
          const s = Math.min(cellW / vw, cellH / vh);
          const dw = vw * s, dh = vh * s, ox = cellX + (cellW - dw) / 2, oy = (cellH - dh) / 2;
          cx.save();
          cx.beginPath(); cx.rect(cellX, 0, cellW, cellH); cx.clip();
          cx.translate(ox, oy); cx.scale(s, s);
          try { cx.drawImage(v, 0, 0, vw, vh); } catch (e) {}
          const snap = nearestSnap(p.log, v.currentTime * 1000);
          if (snap) paintOverlay(cx, vw, vh, snap, p.accent, snap.speed || '');
          cx.restore();
          cx.font = '600 26px sans-serif'; cx.textAlign = 'left';
          const label = `${p.emoji} ${p.name}  ${p.sec.toFixed(2)}s`;
          const tw = cx.measureText(label).width;
          cx.fillStyle = 'rgba(0,0,0,.55)'; cx.fillRect(cellX + 12, 12, tw + (isWin ? 46 : 20), 38);
          cx.fillStyle = '#fff'; cx.fillText(label, cellX + 22, 38);
          if (isWin) cx.fillText('👑', cellX + 22 + tw + 6, 38);
        }
        function tick() {
          if (done) return;
          drawCell(v0, p0, 0, winner === 0);
          drawCell(v1, p1, cellW, winner === 1);
          cx.strokeStyle = 'rgba(255,255,255,.6)'; cx.lineWidth = 3;
          cx.beginPath(); cx.moveTo(cellW, 0); cx.lineTo(cellW, H); cx.stroke();
          if (!stopping && v0.ended && v1.ended) {
            stopping = true;
            setTimeout(() => { if (iv) clearInterval(iv); try { rec.stop(); } catch (e) {} }, 250);
          }
        }
        rec.start();
        iv = setInterval(tick, 33);
        v0.play().catch(() => {}); v1.play().catch(() => {});
      }
    });
  }

  function attachRaceClips() {
    const box = $('#raceClips'); if (!box) return;
    box.innerHTML = race.players.map((p, i) => race.results[i] && race.results[i].blob ? `
      <div class="clip-card">
        <div class="clip-head">${p.emoji} ${p.name} · ${race.results[i].kmh.toFixed(1)} km/h</div>
        <video class="replay-video" playsinline muted loop autoplay controls></video>
        <button class="big save-fx" data-i="${i}">✨ 存特效版</button>
        <button class="secondary save-leg" data-i="${i}">💾 存原始版</button>
      </div>` : '').join('');
    box.querySelectorAll('.clip-card').forEach((card) => {
      const i = +card.querySelector('.save-leg').dataset.i;
      const r = race.results[i];
      const accent = race.players[i] === race.players[0] ? '#d85a30' : '#378add';
      const base = `speed-race-${safeName(race.players[i].name)}-${r.kmh.toFixed(0)}kmh`;
      const vEl = card.querySelector('video');
      vEl.src = URL.createObjectURL(r.blob);
      card.querySelector('.save-leg').onclick = () => saveVideo(r.blob, base + '.' + Vision.recExt());
      let fx = null;
      card.querySelector('.save-fx').onclick = async (e) => {
        const btn = e.currentTarget;
        if (fx) { saveVideo(fx, base + '-fx.' +extFromMime(fx.type)); return; }
        if (!r.log || !r.log.length) { btn.textContent = '✨ 沒有特效資料'; return; }
        btn.disabled = true; btn.textContent = '✨ 製作中…';
        fx = await renderEffectsClip(r.blob, r.log, accent);
        btn.disabled = false;
        if (!fx) { btn.textContent = '✨ 製作失敗'; return; }
        btn.textContent = '✨ 存特效版';
        vEl.src = URL.createObjectURL(fx); vEl.play();
        saveVideo(fx, base + '-fx.' +extFromMime(fx.type));
      };
    });
  }
  function animateReplay(a, b) {
    const rep = $('#replay'); const dur = Math.max(a.sec, b.sec);
    rep.innerHTML = race.players.map((p, i) => `
      <div class="lane">
        <div class="lane-head"><span>${p.emoji} ${p.name}</span><span>${race.results[i].sec.toFixed(2)}s</span></div>
        <div class="track"><div class="runner" id="rn${i}" style="left:0">${p.emoji}</div></div>
      </div>`).join('');
    [a, b].forEach((r, i) => {
      const el = $('#rn' + i); if (!el) return;
      const t = (r.sec / dur);
      setTimeout(() => { el.style.transition = `left ${t * 2.2}s linear`; el.style.left = 'calc(100% - 28px)'; }, 50);
    });
  }

  // ====================================================================
  //  模式：踢球（移動追蹤）
  // ====================================================================
  function mountKick() {
    state.onMeasure = (kmh, sec, blob) => {
      const best = checkBest('kick', kmh);
      celebrate(kmh, best, 'kick', blob);
      setStatus('完成！按「再踢一球」');
    };
    const auto = state.kickMode === 'auto';
    panel.innerHTML = `
      <div class="seg">
        <button class="seg-btn ${auto ? '' : 'active'}" data-km="manual">👆 點按計時</button>
        <button class="seg-btn ${auto ? 'active' : ''}" data-km="auto">📷 自動偵測</button>
      </div>
      ${distanceControl()}
      ${auto ? `<div class="row">
        <label>靈敏度</label>
        <input type="range" id="sens" min="6" max="40" step="2" value="${46 - state.stripMin}">
        <span class="val" id="sensV">中</span>
      </div>` : ''}
      <div class="btn-row">
        <button class="big" id="goBtn">${auto ? '⚽️ 準備踢球' : '👆 開始點按計時'}</button>
      </div>
      <p class="hint">${auto
        ? '把手機<b>放穩</b>（靠著東西、別手持），對準球的路線；綠線/紅線拖到球會經過的地方，球穿過就自動測速。會晃就改用「點按計時」。'
        : '手持也可以！把綠線、紅線對準球會經過的兩點，按開始後：<b>球到綠線點一下、到紅線再點一下</b>，就會算出球速。'}</p>
      ${recordToggle()}`;
    wireDistance(); wireRecord();
    if (auto) {
      const sens = $('#sens'), sensV = $('#sensV');
      const applySens = () => {
        state.stripMin = 46 - +sens.value;
        sensV.textContent = +sens.value > 30 ? '高' : (+sens.value < 16 ? '低' : '中');
      };
      sens.oninput = applySens; applySens();
      Vision.setSensitivity(22);
    }
    updateActionBtn();
    panel.querySelectorAll('.seg-btn').forEach(btn => {
      btn.onclick = () => { state.kickMode = btn.dataset.km; mountKick(); };
    });
  }

  // ---------- 共用：距離控制 ----------
  function distanceControl() {
    return `<div class="row">
      <label>距離</label>
      <input type="range" id="dist" min="2" max="20" step="0.5" value="${state.distance}">
      <span class="val" id="distV">${state.distance} m</span>
    </div>`;
  }
  function wireDistance() {
    const d = $('#dist'), v = $('#distV'); if (!d) return;
    d.oninput = () => { state.distance = +d.value; v.textContent = state.distance + ' m'; };
  }
  function recordToggle() {
    return `<label class="rec-toggle"><input type="checkbox" id="recChk" ${state.record ? 'checked' : ''}> 📹 自動錄影（測完可重播、存到手機）</label>`;
  }
  function wireRecord() {
    const c = $('#recChk'); if (c) c.onchange = () => { state.record = c.checked; };
  }

  // ---------- 鏡頭開啟 ----------
  async function openCamera() {
    coverText.textContent = '正在開啟鏡頭與 AI…';
    try {
      await Vision.start();
      if (state.visionMode === 'pose') {
        coverText.textContent = '正在載入 AI 骨架模型…（第一次需幾秒）';
        try { await Vision.ensurePose(); } catch (e) { console.warn('pose load failed', e); }
      }
      Vision.setMode(state.visionMode);
      camCover.hidden = true;
      setStatus('已就緒');
    } catch (e) {
      coverText.textContent = '無法開啟鏡頭 😢 請允許相機權限，或用「手動計時」。';
      console.error(e);
    }
  }

  // ---------- 模式切換 ----------
  function switchMode(mode) {
    const cfg = MODES[mode];
    state.mode = mode; state.visionMode = cfg.vision; state.accent = cfg.accent; state.distance = cfg.distance;
    document.body.dataset.mode = mode;
    state.counting = false;
    if (state.cdTimer) { clearTimeout(state.cdTimer); state.cdTimer = null; }
    if (Vision.isRecording()) Vision.stopRecording();
    countdownEl.hidden = true; hideTap();
    resetGate(); hideResult(); state.liveSpeed = 0; updateLive();
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
    coverEmoji.textContent = cfg.emoji;

    if (Vision.isLive()) Vision.setMode(cfg.vision);

    if (mode === 'run') mountRun();
    else if (mode === 'race') mountRace();
    else mountKick();

    // 切到需要骨架的模式且鏡頭已開但模型未載入
    if (cfg.vision === 'pose' && Vision.isLive() && !Vision.hasPose()) {
      Vision.ensurePose().then(() => Vision.setMode('pose')).catch(() => {});
    }
  }

  Vision.setOnFrame(gateStep);

  // ---------- 綁定 ----------
  $('#startCam').onclick = openCamera;
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchMode(t.dataset.mode));

  // 紀錄抽屜
  const sheet = $('#recordsSheet');
  $('#recordsBtn').onclick = () => { renderRecords(); sheet.hidden = false; };
  $('#closeRecords').onclick = () => sheet.hidden = true;
  sheet.onclick = e => { if (e.target === sheet) sheet.hidden = true; };
  $('#clearRecords').onclick = () => { localStorage.removeItem(KEY); renderRecords(); };
  function renderRecords() {
    const r = getRecords();
    const rows = [
      { m: 'run', ic: '🏃', name: '跑步最快' },
      { m: 'race', ic: '🚩', name: '比賽最快' },
      { m: 'kick', ic: '⚽️', name: '踢球最強' },
    ].map(x => `<div class="rec-item">
        <div class="rec-l"><span class="rec-ic">${x.ic}</span>${x.name}</div>
        <div class="rec-v">${r[x.m] ? r[x.m].kmh.toFixed(1) : '--'} <small>km/h</small></div>
      </div>`).join('');
    $('#recordsBody').innerHTML = rows;
  }

  // 啟動
  switchMode('run');
})();
