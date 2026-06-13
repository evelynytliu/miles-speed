/* app.js — 導覽、計時門、三模式邏輯、紀錄、語音、慶祝 */
(function () {
  const $ = s => document.querySelector(s);
  const video = $('#cam'), overlay = $('#overlay');
  const statusEl = $('#status'), liveEl = $('#liveSpeed');
  const panel = $('#panel'), resultEl = $('#result');
  const camCover = $('#camCover'), coverText = $('#coverText'), coverEmoji = $('#coverEmoji');
  const countdownEl = $('#countdown');

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

  function arm() { state.phase = 'armed'; state.t1 = 0; state.prevFrac = null; state.prevFracTime = 0; hideResult(); setStatus('就位…等待通過'); updateActionBtn(); }
  function resetGate() { state.phase = 'idle'; state.prevFrac = null; updateActionBtn(); }

  function gateStep(frame) {
    const { point, valid, w } = frame;
    drawScene(frame);
    const now = performance.now();

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

  function decayLive() { state.liveSpeed *= 0.9; if (state.liveSpeed < 0.3) state.liveSpeed = 0; updateLive(); }
  function updateLive() { liveEl.innerHTML = state.liveSpeed.toFixed(1) + ' <small>km/h</small>'; }

  function complete(sec) {
    const kmh = state.distance / sec * 3.6;
    if (navigator.vibrate) navigator.vibrate(60);
    if (state.onMeasure) state.onMeasure(kmh, sec);
    updateActionBtn();
  }

  // ---------- 開始 / 停止流程（主按鈕）----------
  function labelForMode() {
    if (state.mode === 'run') return '🏁 開始計時';
    if (state.mode === 'kick') return '⚽️ 準備踢球';
    if (state.mode === 'race') return '🏁 ' + race.players[race.cur].name + ' 開始';
    return '開始';
  }
  function updateActionBtn() {
    const b = document.querySelector('#goBtn'); if (!b) return;
    const active = state.counting || state.phase === 'armed' || state.phase === 'timing';
    if (active) { b.textContent = '■ 停止／重來'; b.classList.add('stop'); b.onclick = stopFlow; }
    else { b.textContent = labelForMode(); b.classList.remove('stop'); b.onclick = startFlow; }
  }
  async function startFlow() {
    if (!Vision.isLive()) { await openCamera(); if (!Vision.isLive()) return; }
    hideResult();
    if (state.mode === 'kick') { arm(); setStatus('就位…踢出球吧！'); }
    else {
      state.counting = true; updateActionBtn();
      countdown(3, () => { state.counting = false; arm(); });
    }
  }
  function stopFlow() {
    state.counting = false;
    if (state.cdTimer) { clearTimeout(state.cdTimer); state.cdTimer = null; }
    countdownEl.hidden = true;
    resetGate();
    state.liveSpeed = 0; updateLive();
    setStatus('已就緒，按開始');
  }

  // ---------- 畫面繪製（線、追蹤點、骨架）----------
  function drawScene(frame) {
    const { ctx, w, h, point, extra } = frame;
    // 起點 / 終點線
    line(ctx, state.gateA * w, h, '#5dcaa5', '起點');
    line(ctx, state.gateB * w, h, '#f09595', '終點');

    if (state.visionMode === 'pose' && extra.pose) {
      Vision.drawSkeleton(ctx, extra.pose, state.accent);
    }
    if (state.visionMode === 'motion' && extra.motion && extra.motion.box) {
      const b = extra.motion.box;
      ctx.strokeStyle = state.accent; ctx.lineWidth = Math.max(3, w / 220);
      ctx.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
    }
    if (point) {
      ctx.fillStyle = state.accent;
      ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(7, w / 90), 0, 7); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(3, w / 200), 0, 7); ctx.fill();
    }
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

  function celebrate(kmh, best, mode) {
    const accent = state.accent;
    const cheers = mode === 'kick' ? KICK_CHEERS : RUN_CHEERS;
    const cheer = cheers[Math.floor(performance.now() / 137) % cheers.length];
    showResult(`<div class="result-card pop">
      ${gauge(kmh, accent)}
      <div class="result-big">${kmh.toFixed(1)} <small>km/h</small></div>
      <div class="result-sub">${mode === 'kick' ? '球速' : '速度'} · 約 ${(kmh / 3.6).toFixed(1)} 公尺/秒</div>
      ${best ? '<div class="bestbadge">🎉 破紀錄！</div>' : ''}
      <div class="result-cheer">📣 「${cheer}」</div>
    </div>`);
    if (best) confetti();
    speak((best ? '破紀錄了！' : '') + cheer + ' 時速' + kmh.toFixed(0) + '公里');
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
    state.onMeasure = (kmh) => {
      const best = checkBest('run', kmh);
      celebrate(kmh, best, 'run');
      setStatus('完成！按「再來一次」');
    };
    panel.innerHTML = distanceControl() + `
      <div class="btn-row">
        <button class="big" id="goBtn">🏁 開始計時</button>
        <button class="secondary" id="manualBtn">手動</button>
      </div>
      <p class="hint">手機架在<b>側面</b>，讓 Miles 橫向跑過畫面。拖曳綠線/紅線對準起跑與終點。</p>`;
    wireDistance();
    updateActionBtn();
    $('#manualBtn').onclick = manualTimer;
  }

  // ====================================================================
  //  模式：比賽（兩位選手輪流跑同一段）
  // ====================================================================
  const race = { players: [{ name: 'Miles', emoji: '🟠' }, { name: '姊姊', emoji: '🔵' }], cur: 0, results: [] };
  function mountRace() {
    race.cur = 0; race.results = []; state.phase = 'idle'; state.counting = false;
    state.onMeasure = (kmh, sec) => {
      race.results[race.cur] = { kmh, sec };
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
            <div class="pname">${p.emoji} ${p.name}</div>
            <div class="ptime">${race.results[i] ? race.results[i].sec.toFixed(2) : '--'}<small>s</small></div>
          </div>`).join('')}
      </div>
      ${distanceControl()}
      <div class="btn-row">
        <button class="big" id="goBtn">🏁 ${race.players[race.cur].name} 開始</button>
        <button class="secondary" id="resetRace">重來</button>
      </div>
      <p class="hint">同一條跑道，兩人輪流跑。跑完自動換下一位，最後比出贏家！</p>`;
    wireDistance();
    state.phase = 'idle'; state.counting = false;
    updateActionBtn();
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
    </div>`);
    animateReplay(a, b);
    confetti();
    speak(win.name + ' 贏了！快了 ' + diff.toFixed(1) + ' 秒');
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
    state.onMeasure = (kmh) => {
      const best = checkBest('kick', kmh);
      celebrate(kmh, best, 'kick');
      setStatus('完成！按「再踢一球」');
    };
    panel.innerHTML = distanceControl() + `
      <div class="row">
        <label>靈敏度</label>
        <input type="range" id="sens" min="12" max="50" step="2" value="28">
        <span class="val" id="sensV">中</span>
      </div>
      <div class="btn-row">
        <button class="big" id="goBtn">⚽️ 準備踢球</button>
        <button class="secondary" id="manualBtn">手動</button>
      </div>
      <p class="hint">手機架在<b>側面</b>對準球的路線，球飛過兩條線就會測出球速。背景單純、亮色球最準。</p>`;
    wireDistance();
    const sens = $('#sens'), sensV = $('#sensV');
    sens.oninput = () => {
      Vision.setSensitivity(+sens.value);
      sensV.textContent = +sens.value < 22 ? '高' : (+sens.value > 38 ? '低' : '中');
    };
    Vision.setSensitivity(+sens.value);
    updateActionBtn();
    $('#manualBtn').onclick = manualTimer;
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

  // ---------- 手動計時（無鏡頭備案）----------
  function manualTimer() {
    let t0 = 0, on = false;
    setStatus('手動計時：點畫面開始，再點一次停止');
    const handler = () => {
      if (!on) { t0 = performance.now(); on = true; setStatus('計時中…再點一次停止'); }
      else {
        on = false; overlay.removeEventListener('pointerdown', handler);
        const sec = (performance.now() - t0) / 1000;
        const kmh = state.distance / sec * 3.6;
        const best = checkBest(state.mode, kmh);
        celebrate(kmh, best, state.mode);
      }
    };
    overlay.addEventListener('pointerdown', handler);
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
