/* ============================================================
   WatermarkZero — 前端逻辑（专治右下角 AI生成 / 豆包AI生成 标记）
   上传 → 自动框选标记（可微调）→ AI 仅重建框内 → 对比 → 下载
   ============================================================ */
'use strict';

const $ = (id) => document.getElementById(id);

const MAX_UPLOAD = 20 * 1024 * 1024;  // 20MB
const AI_MAX_SIDE = 1600;             // 送检给 AI 的最长边
const DETECT_MAX_SIDE = 800;          // 智能定位用图最长边
const REMOVE_PROMPT =
  '擦除白色遮罩区域内的「AI生成」或「豆包AI生成」文字标记及其小图标，' +
  '用周围背景自然重建该区域，遮罩外的画面保持完全不变。';

/* ---------- 模型注册表（与后端一致） ---------- */
const EDIT_MODELS = {
  'wanx2.1-imageedit': { hint: '均衡 · 遮罩精修 · 约 15~40 秒', tip: '通常需要 15 ~ 40 秒' },
  'wan2.7-image-pro': { hint: '极速 · 约 10~20 秒', tip: '该模型速度极快，通常 10 ~ 20 秒完成' },
  'qwen-image-3.0': { hint: '高清 2K 重建 · 约 40~80 秒', tip: '该模型重建精度最高，通常 40 ~ 80 秒完成' },
};

const state = {
  file: null,
  fileName: 'image.png',
  fileType: 'image/png',
  origW: 0, origH: 0,
  origBitmap: null,
  box: null,            // 归一化 {x0,y0,x1,y1}（0~1，相对图片宽高）
  detected: false,
  finalCanvas: null,
  detecting: false,
};

/* ---------------- 模型选择 ---------------- */
const selectEditModel = $('select-edit-model');
const selectDetectModel = $('select-detect-model');
const LS_MODELS = 'wz_models_v1';

(function restoreModels() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_MODELS) || '{}');
    if (EDIT_MODELS[saved.edit]) selectEditModel.value = saved.edit;
    if (saved.detect === 'local' || selectDetectModel.querySelector(`option[value="${saved.detect}"]`)) {
      selectDetectModel.value = saved.detect;
    }
  } catch (e) { /* 忽略 */ }
})();

function persistModels() {
  try {
    localStorage.setItem(LS_MODELS, JSON.stringify({ edit: selectEditModel.value, detect: selectDetectModel.value }));
  } catch (e) { /* 忽略 */ }
}

function updateEditHint() {
  const m = EDIT_MODELS[selectEditModel.value];
  $('edit-model-hint').textContent = m ? m.hint : '';
}
selectEditModel.addEventListener('change', () => { updateEditHint(); persistModels(); });
selectDetectModel.addEventListener('change', () => { persistModels(); });
updateEditHint();

/* ---------------- 通用 ---------------- */
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function switchView(name) {
  for (const v of ['upload', 'editor', 'processing', 'result']) {
    $('view-' + v).hidden = v !== name;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/* ---------------- 对比滑块 ---------------- */
function setupCompare(root) {
  const afterWrap = root.querySelector('.compare-after');
  const afterImg = afterWrap.querySelector('img');
  const handle = root.querySelector('.compare-handle');
  let pos = 50;

  function set(p) {
    pos = Math.min(99, Math.max(1, p));
    afterWrap.style.width = pos + '%';
    handle.style.left = pos + '%';
  }
  function layout() {
    afterImg.style.width = root.clientWidth + 'px';
    set(pos);
  }
  function fromEvent(e) {
    const rect = root.getBoundingClientRect();
    set(((e.clientX - rect.left) / rect.width) * 100);
  }
  let dragging = false;
  root.addEventListener('pointerdown', (e) => {
    dragging = true; root.setPointerCapture(e.pointerId); fromEvent(e);
  });
  root.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
  root.addEventListener('pointerup', () => { dragging = false; });
  root.addEventListener('pointercancel', () => { dragging = false; });
  if (afterImg.complete) layout(); else afterImg.addEventListener('load', layout);
  window.addEventListener('resize', layout);
  return { layout };
}

document.querySelectorAll('.compare[data-before]').forEach(setupCompare);
const resultCompare = setupCompare($('result-compare'));

/* ---------------- 上传 ---------------- */
const dropzone = $('dropzone');
const fileInput = $('file-input');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); fileInput.value = ''; });
['dragover', 'dragenter'].forEach(ev => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f);
});

async function handleFile(file) {
  const errBox = $('upload-error');
  errBox.hidden = true;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    errBox.textContent = '不支持的格式，请上传 JPG、PNG 或 WEBP 图片'; errBox.hidden = false; return;
  }
  if (file.size > MAX_UPLOAD) {
    errBox.textContent = '图片超过 20MB，请压缩后再上传'; errBox.hidden = false; return;
  }
  try {
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    state.file = file;
    state.fileName = file.name || 'image';
    state.fileType = file.type;
    state.origBitmap = img;
    state.origW = img.naturalWidth;
    state.origH = img.naturalHeight;
    state.finalCanvas = null;
    switchView('editor');
    initEditor();
  } catch (e) {
    errBox.textContent = '图片读取失败，请重试'; errBox.hidden = false;
  }
}

/* ---------------- 编辑器：图片 + 标记框 ---------------- */
const baseCanvas = $('base-canvas');
const markBox = $('mark-box');
const bctx = baseCanvas.getContext('2d');

function initEditor() {
  const wrap = $('canvas-wrap');
  const maxW = Math.min(wrap.clientWidth - 2, 900);
  const maxH = Math.max(window.innerHeight * 0.6, 300);
  const scale = Math.min(maxW / state.origW, maxH / state.origH, 1);
  const w = Math.max(1, Math.round(state.origW * scale));
  const h = Math.max(1, Math.round(state.origH * scale));
  baseCanvas.width = w; baseCanvas.height = h;
  baseCanvas.style.width = w + 'px'; baseCanvas.style.height = h + 'px';
  bctx.drawImage(state.origBitmap, 0, 0, w, h);
  runDetection();
  $('editor-meta').textContent = `原始尺寸 ${state.origW} × ${state.origH} px · ${Math.max(1, Math.round(state.file.size / 1024))} KB`;
}

window.addEventListener('resize', () => {
  if (!$('view-editor').hidden && state.origBitmap) initEditor();
});

/* ---------- 自动检测：右下角白色文字标记 ---------- */
function autoDetect() {
  // 缩小到 ≤900px 分析
  const scale = Math.min(900 / state.origW, 900 / state.origH, 1);
  const w = Math.max(32, Math.round(state.origW * scale));
  const h = Math.max(32, Math.round(state.origH * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.drawImage(state.origBitmap, 0, 0, w, h);
  let data;
  try { data = cx.getImageData(0, 0, w, h).data; }
  catch (e) { setFallbackBox(); return; }

  // 搜索区域：右下 40% × 20%
  const rx0 = Math.floor(w * 0.60), ry0 = Math.floor(h * 0.80);
  const colHist = new Array(w).fill(0);
  const rowHist = new Array(h).fill(0);
  let total = 0, sum = 0;

  // 第一遍：估计区域平均亮度（自适应阈值）
  for (let y = ry0; y < h; y++) {
    for (let x = rx0; x < w; x++) {
      const j = (y * w + x) * 4;
      sum += 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    }
  }
  const mean = sum / ((w - rx0) * (h - ry0));
  const thMin = Math.max(145, Math.min(mean + 30, 200));
  const thSat = 80;

  // 第二遍：候选白色低饱和像素
  for (let y = ry0; y < h; y++) {
    for (let x = rx0; x < w; x++) {
      const j = (y * w + x) * 4;
      const r = data[j], g = data[j + 1], b = data[j + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mn > thMin && mx - mn < thSat) {
        colHist[x]++; rowHist[y]++; total++;
      }
    }
  }

  const minCnt = 2;
  let x0 = -1, x1 = -1, y0 = -1, y1 = -1;
  for (let x = rx0; x < w; x++) if (colHist[x] >= minCnt) { if (x0 < 0) x0 = x; x1 = x; }
  for (let y = ry0; y < h; y++) if (rowHist[y] >= minCnt) { if (y0 < 0) y0 = y; y1 = y; }

  const regionArea = (w - rx0) * (h - ry0);
  const ok = total >= Math.max(24, regionArea * 0.0012)
    && x0 >= 0 && y0 >= 0
    && (x1 - x0) >= w * 0.02 && (y1 - y0) >= h * 0.012
    && (x1 - x0) <= w * 0.5 && (y1 - y0) <= h * 0.18;

  if (!ok) { setFallbackBox(); return; }

  // 外扩：左侧多留一些（细笔画易漏检），四周留 padding
  const bw = x1 - x0, bh = y1 - y0;
  const pad = Math.max(5, Math.round(w * 0.012));
  const bx0 = Math.max(0, (x0 - bw * 0.18 - pad) / w);
  const by0 = Math.max(0, (y0 - bh * 0.25 - pad) / h);
  const bx1 = Math.min(1, (x1 + pad + 1) / w);
  const by1 = Math.min(1, (y1 + pad + 1) / h);
  setBox({ x0: bx0, y0: by0, x1: bx1, y1: by1 }, true);
}

function setFallbackBox() {
  // 默认框：右下角 20% × 8%
  const mx = 14 / state.origW, my = 12 / state.origH;
  setBox({
    x0: 1 - 0.20 - mx, y0: 1 - 0.085 - my,
    x1: 1 - mx, y1: 1 - my,
  }, false);
}

/* ---------- 检测入口：本地像素检测 或 视觉模型 AI 定位 ---------- */
let detectSeq = 0;

function buildDetectImage() {
  const scale = Math.min(DETECT_MAX_SIDE / state.origW, DETECT_MAX_SIDE / state.origH, 1);
  const w = Math.max(64, Math.round(state.origW * scale));
  const h = Math.max(64, Math.round(state.origH * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(state.origBitmap, 0, 0, w, h);
  return { dataUrl: c.toDataURL('image/jpeg', 0.88), w, h };
}

async function runDetection() {
  if (state.detecting) return;
  if (selectDetectModel.value === 'local') { autoDetect(); return; }

  const seq = ++detectSeq;
  state.detecting = true;
  const st = $('detect-status');
  st.classList.remove('warn');
  st.querySelector('.dot').style.background = '#E0A030';
  $('detect-text').textContent = `AI 正在识别标记位置（${selectDetectModel.value}）…`;

  // 先用本地检测放一个初始框，避免 AI 期间无框
  autoDetect();

  try {
    const { dataUrl } = buildDetectImage();
    const r = await fetch('/api/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl, model: selectDetectModel.value }),
    });
    const data = await r.json();
    if (seq !== detectSeq) return;
    if (!data.ok) throw new Error(data.error || 'AI 定位失败');
    if (data.has && data.box) {
      const b = data.box;
      // 外扩：水印包围盒稍放宽，避免贴边裁到笔画
      const padX = (b.x1 - b.x0) * 0.25 + 0.012;
      const padY = (b.y1 - b.y0) * 0.30 + 0.014;
      setBox({
        x0: Math.max(0, b.x0 - padX), y0: Math.max(0, b.y0 - padY),
        x1: Math.min(1, b.x1 + padX * 0.6), y1: Math.min(1, b.y1 + padY * 0.6),
      }, true);
      $('detect-text').textContent = `AI 已定位标记（${data.model}）`;
    } else {
      setFallbackBox();
      $('detect-text').textContent = 'AI 未发现明显标记，已放置默认框，请拖动调整';
      st.classList.add('warn');
    }
    st.querySelector('.dot').style.background = '';
  } catch (e) {
    if (seq !== detectSeq) return;
    st.querySelector('.dot').style.background = '';
    st.classList.add('warn');
    $('detect-text').textContent = 'AI 定位失败，已回退本地检测';
    toast(e.message || 'AI 智能定位失败，已回退本地检测');
  } finally {
    if (seq === detectSeq) state.detecting = false;
  }
}

function setBox(box, detected) {
  // 限制在图片内
  box.x0 = Math.max(0, Math.min(box.x0, 0.98));
  box.y0 = Math.max(0, Math.min(box.y0, 0.98));
  box.x1 = Math.min(1, Math.max(box.x1, box.x0 + 0.02));
  box.y1 = Math.min(1, Math.max(box.y1, box.y0 + 0.015));
  box.x1 = Math.min(1, box.x1);
  box.y1 = Math.min(1, box.y1);
  state.box = box;
  state.detected = detected;
  renderBox();
  // 布局尚未稳定时（画布尺寸刚变化）补一次，确保框与画布精确对齐
  requestAnimationFrame(() => { if (state.box === box) renderBox(); });
  const st = $('detect-status');
  st.classList.toggle('warn', !detected);
  $('detect-text').textContent = detected
    ? '已自动定位右下角标记'
    : '未可靠检测到标记，已放置默认框，请拖动调整';
}

function renderBox() {
  const b = state.box;
  if (!b) return;
  // 画布在容器内居中（flex center），标注框以容器为定位基准，必须补上画布偏移；
  // 用实时 rect 测量，避免 CSS max-height/max-width 缩放导致 clientHeight 与视觉尺寸不一致。
  const cr = baseCanvas.getBoundingClientRect();
  const parent = markBox.offsetParent || baseCanvas.parentElement;
  const pr = parent.getBoundingClientRect();
  const ox = cr.left - pr.left;
  const oy = cr.top - pr.top;
  const cw = cr.width, ch = cr.height;
  markBox.style.display = 'block';
  markBox.style.left = (ox + b.x0 * cw) + 'px';
  markBox.style.top = (oy + b.y0 * ch) + 'px';
  markBox.style.width = ((b.x1 - b.x0) * cw) + 'px';
  markBox.style.height = ((b.y1 - b.y0) * ch) + 'px';
}

/* 画布尺寸变化（窗口缩放、布局回流）时重新对齐标注框 */
if (window.ResizeObserver) {
  new ResizeObserver(() => { if (state.box) renderBox(); }).observe(baseCanvas);
}

/* ---------- 框交互：拖动移动 + 四角缩放 ---------- */
let boxDrag = null; // {mode:'move'|corner, startBox, startPoint}
function normPoint(e) {
  const rect = baseCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
  };
}
markBox.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const corner = e.target.dataset && e.target.dataset.corner;
  boxDrag = { mode: corner || 'move', corner, startBox: { ...state.box }, start: normPoint(e) };
  markBox.setPointerCapture(e.pointerId);
});
markBox.addEventListener('pointermove', (e) => {
  if (!boxDrag) return;
  const p = normPoint(e);
  const s = boxDrag.startBox, d = boxDrag.start;
  const dx = p.x - d.x, dy = p.y - d.y;
  let b = state.box;
  if (boxDrag.mode === 'move') {
    const w0 = s.x1 - s.x0, h0 = s.y1 - s.y0;
    let nx0 = s.x0 + dx, ny0 = s.y0 + dy;
    nx0 = Math.max(0, Math.min(nx0, 1 - w0));
    ny0 = Math.max(0, Math.min(ny0, 1 - h0));
    b = { x0: nx0, y0: ny0, x1: nx0 + w0, y1: ny0 + h0 };
  } else {
    b = { ...s };
    if (boxDrag.corner.includes('w')) b.x0 = Math.max(0, Math.min(p.x, s.x1 - 0.03));
    if (boxDrag.corner.includes('e')) b.x1 = Math.min(1, Math.max(p.x, s.x0 + 0.03));
    if (boxDrag.corner.includes('n')) b.y0 = Math.max(0, Math.min(p.y, s.y1 - 0.02));
    if (boxDrag.corner.includes('s')) b.y1 = Math.min(1, Math.max(p.y, s.y0 + 0.015));
  }
  state.box = b;
  state.detected = state.detected; // 保持状态文案
  renderBox();
});
['pointerup', 'pointercancel'].forEach(ev => markBox.addEventListener(ev, () => { boxDrag = null; }));

$('btn-redetect').addEventListener('click', runDetection);
$('btn-change').addEventListener('click', () => switchView('upload'));
$('btn-new').addEventListener('click', () => switchView('upload'));
$('btn-retry').addEventListener('click', () => switchView('editor'));

/* ---------------- 送检准备 ---------------- */
function buildAIImage() {
  const scale = Math.min(AI_MAX_SIDE / state.origW, AI_MAX_SIDE / state.origH, 1);
  const w = Math.max(64, Math.round(state.origW * scale));
  const h = Math.max(64, Math.round(state.origH * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(state.origBitmap, 0, 0, w, h);
  return { dataUrl: c.toDataURL('image/jpeg', 0.93), w, h };
}

function buildMaskURL(w, h) {
  const b = state.box;
  const pad = Math.max(3, Math.round(w * 0.006)); // 额外保险边
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.fillStyle = '#fff';
  const rx0 = Math.max(0, (b.x0 * w) - pad);
  const ry0 = Math.max(0, (b.y0 * h) - pad);
  const rx1 = Math.min(w, (b.x1 * w) + pad);
  const ry1 = Math.min(h, (b.y1 * h) + pad);
  cx.fillRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
  return c.toDataURL('image/png');
}

/* ---------------- 处理流程 ---------------- */
let stageTimer = null;
const STAGES = [
  [0,   '正在上传图片…'],
  [1.2, '已提交，AI 正在分析标记区域…'],
  [6,   'AI 正在重建标记下方的背景…'],
  [14,  '即将完成，正在合成高清结果…'],
];

function startProgress() {
  const t0 = Date.now();
  let stageIdx = -1;
  stageTimer = setInterval(() => {
    const s = (Date.now() - t0) / 1000;
    for (let i = STAGES.length - 1; i >= 0; i--) {
      if (s >= STAGES[i][0]) {
        if (i !== stageIdx) { stageIdx = i; $('processing-stage').textContent = STAGES[i][1]; }
        break;
      }
    }
    $('processing-elapsed').textContent = s.toFixed(0) + 's';
    $('progress-bar').style.width = Math.min(92, 5 + s * 2.6) + '%';
  }, 250);
}
function stopProgress() { clearInterval(stageTimer); $('progress-bar').style.width = '100%'; }

$('btn-remove').addEventListener('click', async () => {
  if (state.processing) return;
  state.processing = true;
  $('btn-remove').disabled = true;
  const editModel = selectEditModel.value;
  const meta = EDIT_MODELS[editModel] || {};
  $('processing-tip').textContent = `当前引擎 ${editModel} · ${meta.tip || '通常需要 10 ~ 40 秒'}`;
  switchView('processing');
  startProgress();
  try {
    const ai = buildAIImage();
    const r = await fetch('/api/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: ai.dataUrl,
        mask: buildMaskURL(ai.w, ai.h),
        prompt: REMOVE_PROMPT,
        model: editModel,
      }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'AI 处理失败，请重试');
    await showResult(data.image, data.model || editModel);
  } catch (e) {
    toast(e.message || '网络错误，请重试');
    switchView('editor');
  } finally {
    stopProgress();
    state.processing = false;
    $('btn-remove').disabled = false;
  }
});

/* ---------------- 结果合成：仅框内替换 ---------------- */
async function showResult(aiDataUrl, modelUsed) {
  const aiImg = await loadImage(aiDataUrl);
  const ow = state.origW, oh = state.origH;

  const out = document.createElement('canvas');
  out.width = ow; out.height = oh;
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(state.origBitmap, 0, 0, ow, oh); // 整图 = 原始像素

  // 框内才使用 AI 重建结果（羽化边缘）
  const b = state.box;
  const pad = Math.max(3, Math.round(ow * 0.006));
  const feather = Math.max(3, Math.round(ow / 320));
  const m = document.createElement('canvas');
  m.width = ow; m.height = oh;
  const mctx = m.getContext('2d');
  mctx.fillStyle = '#fff';
  mctx.fillRect(
    Math.max(0, b.x0 * ow - pad), Math.max(0, b.y0 * oh - pad),
    (b.x1 - b.x0) * ow + pad * 2, (b.y1 - b.y0) * oh + pad * 2
  );
  mctx.filter = `blur(${feather}px)`;
  mctx.drawImage(m, 0, 0);
  mctx.filter = 'none';

  const tmp = document.createElement('canvas');
  tmp.width = ow; tmp.height = oh;
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(aiImg, 0, 0, ow, oh);
  tctx.globalCompositeOperation = 'destination-in';
  tctx.drawImage(m, 0, 0);
  tctx.globalCompositeOperation = 'source-over';
  octx.drawImage(tmp, 0, 0);

  // 展示
  const beforeFull = document.createElement('canvas');
  beforeFull.width = ow; beforeFull.height = oh;
  beforeFull.getContext('2d').drawImage(state.origBitmap, 0, 0, ow, oh);
  $('result-before').src = beforeFull.toDataURL('image/jpeg', 0.9);
  $('result-after').src = out.toDataURL('image/jpeg', 0.92);
  $('result-dims').textContent = `${ow} × ${oh} px · ${modelUsed || ''}`;
  $('result-note').textContent = '除标记框内外，其余像素与原图完全一致（AI 输出中可能出现的角标也会被自动丢弃）';
  state.finalCanvas = out;
  switchView('result');
  resultCompare.layout();
}

/* ---------------- 下载 ---------------- */
$('btn-download').addEventListener('click', () => {
  if (!state.finalCanvas) return;
  const type = state.fileType === 'image/png' ? 'image/png' : 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : 'jpg';
  state.finalCanvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const base = state.fileName.replace(/\.[^.]+$/, '') || 'image';
    a.download = `去标记_${base}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('已开始下载');
  }, type, 0.95);
});
