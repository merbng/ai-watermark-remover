/**
 * AI 在线图片去水印 - 本地服务
 * 纯 Node.js 实现（无第三方依赖）：
 *  - 静态托管 public/
 *  - POST /api/remove：代理通义千问（DashScope wanx2.1-imageedit）图像编辑，
 *    支持整体指令去水印与遮罩局部去水印，提交异步任务并轮询结果。
 *
 * 运行：node server.js  （默认端口 3777，可用 PORT 环境变量覆盖）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3777);
const PUBLIC_DIR = path.join(__dirname, 'public');

/* 读取 .env（无第三方依赖），便于本地与容器部署配置密钥 */
function loadEnvFile() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      if (process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (e) { /* 忽略 .env 读取失败 */ }
}
loadEnvFile();

/*
 * 清洗环境变量里的 API Key。
 * 常见误操作：把整个 .env 文件（多行）一次性粘进云平台的单个变量输入框，
 * 值会变成 "sk-xxx\nRATE_LIMIT_PER_HOUR=40" 这类脏数据，
 * 直接拼进 Authorization 头会抛 "invalid header value"。
 * 这里统一提取第一个合法的 sk- 令牌。
 */
function normalizeApiKey(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // 处理字面量 \n（某些面板会把换行转义成两个字符）
  s = s.replace(/\\r\\n|\\n|\\r/g, '\n');
  // 优先匹配「KEY=sk-xxx」或裸 sk-xxx 的整行
  for (const line of s.split(/[\r\n]+/)) {
    const m = /^\s*(?:[A-Za-z0-9_]+\s*=\s*)?(sk-[A-Za-z0-9._-]{8,})\s*$/.exec(line);
    if (m) return m[1];
  }
  // 兜底：从任意位置抓第一个 sk- 令牌（遇到空格/引号/分号即止）
  const m2 = /(sk-[A-Za-z0-9._-]{8,})/.exec(s);
  if (m2) return m2[1];
  return s.split(/[\s,;'"`]+/)[0] || '';
}

const RAW_KEY = process.env.DASHSCOPE_API_KEY || '';
const DASHSCOPE_KEY = normalizeApiKey(RAW_KEY);
// 限流数值同样做容错：Number("40 RATE_LIMIT...") 会得到 NaN
const rateRaw = parseInt(String(process.env.RATE_LIMIT_PER_HOUR || '40'), 10);
const RATE_LIMIT_PER_HOUR = Number.isFinite(rateRaw) && rateRaw > 0 ? rateRaw : 40;
// Key 合法形态校验：必须是以 sk- 开头的单行令牌
const KEY_OK = /^sk-[A-Za-z0-9._-]{8,}$/.test(DASHSCOPE_KEY);
if (RAW_KEY && RAW_KEY.trim() !== DASHSCOPE_KEY) {
  console.warn('[WatermarkZero] DASHSCOPE_API_KEY 含有换行或多余内容，已自动提取有效 Key（建议在平台上重新只填 Key 本身）');
}
if (!KEY_OK) {
  console.warn('[WatermarkZero] 警告：DASHSCOPE_API_KEY 缺失或格式不合法，去水印接口将不可用');
}

/* 简单的按 IP 限流，避免公开链接被刷爆 API 额度 */
const rateHits = new Map();
function isRateLimited(req) {
  if (!RATE_LIMIT_PER_HOUR) return false;
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const rec = rateHits.get(ip) || { start: now, count: 0 };
  if (now - rec.start > 3600 * 1000) { rec.start = now; rec.count = 0; }
  rec.count += 1;
  rateHits.set(ip, rec);
  if (rateHits.size > 5000) {
    for (const [k, v] of rateHits) if (now - v.start > 3600 * 1000) rateHits.delete(k);
  }
  return rec.count > RATE_LIMIT_PER_HOUR;
}
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1';
const DASHSCOPE_COMPAT = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

/* ---------- 模型注册表（全部经真实 API 验证可用） ---------- */
// 去水印引擎：图像编辑模型（真正执行擦除重建）
const IMAGE_MODELS = {
  'wanx2.1-imageedit': {
    kind: 'imageedit',   // 异步 image-synthesis，原生遮罩支持
    label: 'wanx2.1-imageedit',
    hint: '均衡 · 遮罩精修 · 约 15~40 秒',
  },
  'wan2.7-image-pro': {
    kind: 'multimodal',  // 同步多模态接口，遮罩以第二张图传入
    label: 'wan2.7-image-pro',
    hint: '极速 · 约 10~20 秒',
  },
  'qwen-image-3.0': {
    kind: 'multimodal',
    label: 'Qwen-Image-3.0',
    hint: '高清 2K 重建 · 约 40~80 秒',
  },
};
const DEFAULT_IMAGE_MODEL = 'wanx2.1-imageedit';

// 智能定位：多模态视觉理解模型（返回水印包围盒）
const VISION_MODELS = {
  'qwen3.8-flash': { label: 'qwen3.8-flash', hint: '快 · 推荐' },
  'qwen3.8-max': { label: 'qwen3.8-max', hint: '旗舰 · 最准' },
  'qwen3.8-omni-flash': { label: 'qwen3.8-omni-flash', hint: '全模态 · 快' },
  'qwen3.8-27b': { label: 'qwen3.8-27b', hint: '开源旗舰' },
  'kimi-k3': { label: 'kimi-k3', hint: 'Kimi 视觉' },
  'qwen3.7-plus': { label: 'qwen3.7-plus', hint: '均衡' },
  'qwen3.7-max-2026-06-08': { label: 'qwen3.7-max-2026-06-08', hint: '上代旗舰' },
};

const MASK_NOTE =
  '第二张图为遮罩图：白色区域是需要擦除的水印标记位置，请只重建白色区域内的内容（擦除其中的水印文字与图标），' +
  '黑色区域与画面其他部分保持完全不变。';

const MAX_BODY = 32 * 1024 * 1024; // 32MB
const MAX_POLL = 48;               // 48 * 2.5s = 120s

const DEFAULT_PROMPT_AUTO =
  '彻底去除图片中的所有水印、半透明水印、文字、logo标志和日期时间戳，' +
  '用周围背景内容自然重建被水印覆盖的区域，画面其余部分保持原样不变，' +
  '输出一张没有任何水印文字的干净图片。';
const DEFAULT_PROMPT_MASK =
  '去除选中白色区域内的水印、文字或标志，用周围背景内容自然重建该区域，' +
  '区域外的画面保持完全不变。';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function parseDataUrl(s) {
  if (typeof s !== 'string') return null;
  const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(s);
  if (!m) return null;
  const b64 = m[2].replace(/\s+/g, '');
  if (!b64 || b64.length > 26 * 1024 * 1024) return null; // ~19MB 原始
  return { mime: m[1], base64: b64 };
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('图片过大，请上传 20MB 以内的图片'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function dashscopeSubmit(payload) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90 * 1000);
  try {
    const r = await fetch(`${DASHSCOPE_BASE}/services/aigc/image2image/image-synthesis`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Authorization': `Bearer ${DASHSCOPE_KEY}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.output || !j.output.task_id) {
      const code = (j && j.code) || r.status;
      const msg = (j && j.message) || `提交任务失败（HTTP ${r.status}）`;
      const err = new Error(msg);
      err.code = code;
      throw err;
    }
    return j.output.task_id;
  } finally {
    clearTimeout(timer);
  }
}

/* 同步多模态图像编辑（wan2.7-image-pro / qwen-image-3.0） */
async function multimodalEdit(model, imageDataUrl, maskDataUrl, prompt) {
  const content = [{ image: imageDataUrl }];
  let text = prompt;
  if (maskDataUrl) {
    content.push({ image: maskDataUrl });
    text = `${prompt}\n${MASK_NOTE}`;
  }
  content.push({ text });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180 * 1000);
  try {
    const r = await fetch(`${DASHSCOPE_BASE}/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Authorization': `Bearer ${DASHSCOPE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: { messages: [{ role: 'user', content }] },
        parameters: { watermark: false },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j && j.message) || `模型调用失败（HTTP ${r.status}）`;
      throw new Error(msg);
    }
    const choices = j.output && j.output.choices;
    const parts = choices && choices[0] && choices[0].message && choices[0].message.content;
    const url = Array.isArray(parts) && parts.find((p) => p && p.type === 'image' && p.image);
    if (!url) throw new Error('模型未返回结果图片，请重试');
    return url.image;
  } finally {
    clearTimeout(timer);
  }
}

/* 视觉模型智能定位水印（返回归一化包围盒） */
const DETECT_QUESTION =
  '仔细观察这张图片，重点检查右下角区域是否存在水印、文字标记或 logo' +
  '（例如「AI生成」「豆包AI生成」等 AI 生成标识，可能为白色实心、半透明或带小图标）。' +
  '如果存在，返回能紧密框住整个标记（含小图标）的包围盒。' +
  '只输出一个 JSON 对象，不要输出其他任何内容：' +
  '{"has":true,"box":[x0,y0,x1,y1]}，坐标为 0-1000 归一化（相对图片宽高）。' +
  '如果没有检测到任何水印标记，输出 {"has":false}。';

async function visionDetect(model, imageDataUrl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120 * 1000);
  try {
    const r = await fetch(`${DASHSCOPE_COMPAT}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Authorization': `Bearer ${DASHSCOPE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: DETECT_QUESTION },
          ],
        }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j && (j.error && j.error.message || j.message)) || `定位模型调用失败（HTTP ${r.status}）`;
      throw new Error(msg);
    }
    const text = ((j.choices || [])[0] || {}).message || {};
    const content = String(text.content || '');
    const m = content.match(/\{[^{}]*\}/);
    if (!m) throw new Error('定位模型未返回有效结果');
    const parsed = JSON.parse(m[0]);
    if (!parsed.has) return { has: false };
    const b = parsed.box;
    if (!Array.isArray(b) || b.length !== 4 || b.some((v) => typeof v !== 'number' || !isFinite(v))) {
      throw new Error('定位结果格式异常');
    }
    // 0-1000 归一化 → 0-1；容错：若值明显在 0-1 区间则视为已是小数
    const scale = b.every((v) => v <= 1.5) ? 1 : 1000;
    let [x0, y0, x1, y1] = b.map((v) => v / scale);
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (y0 > y1) [y0, y1] = [y1, y0];
    return { has: true, box: { x0, y0, x1, y1 } };
  } finally {
    clearTimeout(timer);
  }
}

async function dashscopePoll(taskId) {
  for (let i = 0; i < MAX_POLL; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20 * 1000);
    let j;
    try {
      const r = await fetch(`${DASHSCOPE_BASE}/tasks/${taskId}`, {
        signal: ac.signal,
        headers: { 'Authorization': `Bearer ${DASHSCOPE_KEY}` },
      });
      j = await r.json().catch(() => ({}));
    } catch (e) {
      continue; // 网络抖动重试
    } finally {
      clearTimeout(timer);
    }
    const out = j.output || {};
    if (out.task_status === 'SUCCEEDED') {
      const url = out.results && out.results[0] && out.results[0].url;
      if (!url) throw new Error('任务成功但未返回图片');
      return url;
    }
    if (out.task_status === 'FAILED' || out.task_status === 'CANCELED' || out.task_status === 'UNKNOWN') {
      const msg = out.message || out.code || 'AI 处理失败，请重试';
      throw new Error(String(msg));
    }
  }
  throw new Error('处理超时，请重试或换一张较小的图片');
}

async function fetchAsDataUrl(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60 * 1000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`下载结果失败（HTTP ${r.status}）`);
    const buf = Buffer.from(await r.arrayBuffer());
    return `data:image/png;base64,${buf.toString('base64')}`;
  } finally {
    clearTimeout(timer);
  }
}

/* 内容审核拦截判断：阿里云对输入/输出图都会做安全检测 */
function isModerationError(msg) {
  return /inappropriate content|data_inspection_failed|inappropriate|risk.*content|content.*risk/i.test(String(msg || ''));
}

/* 审核误伤时常用于重试的保守提示词：明确不要生成人物/肢体 */
const SAFE_PROMPT_MASK =
  '仅用遮罩周边原有的背景纹理、颜色和光影填补白色遮罩区域，' +
  '不要生成人物、人脸、肢体、皮肤或任何文字，遮罩以外的画面保持完全不变。';

/* 执行一次图像编辑，返回结果图 dataURL */
async function runEdit(model, ctx) {
  const { imgDataUrl, maskDataUrl, prompt, useMask } = ctx;
  if (IMAGE_MODELS[model].kind === 'imageedit') {
    const input = {
      function: useMask ? 'description_edit_with_mask' : 'description_edit',
      prompt,
      base_image_url: imgDataUrl,
    };
    if (useMask) input.mask_image_url = maskDataUrl;
    const taskId = await dashscopeSubmit({ model, input, parameters: { n: 1, watermark: false } });
    const url = await dashscopePoll(taskId);
    return fetchAsDataUrl(url);
  }
  // 同步多模态模型（wan2.7-image-pro / qwen-image-3.0）
  const url = await multimodalEdit(model, imgDataUrl, maskDataUrl, prompt);
  return fetchAsDataUrl(url);
}

async function handleRemove(req, res) {
  if (!KEY_OK) {
    return sendJson(res, 503, {
      ok: false,
      error: '服务端 DASHSCOPE_API_KEY 缺失或格式不合法（常见原因：把 .env 多行内容粘进了同一个变量），请只填写以 sk- 开头的一行 Key 后重新部署',
    });
  }
  if (isRateLimited(req)) {
    return sendJson(res, 429, { ok: false, error: `已超过每小时 ${RATE_LIMIT_PER_HOUR} 次的使用上限，请稍后再试` });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message || '请求体无效' });
  }
  const img = parseDataUrl(body.image);
  if (!img) return sendJson(res, 400, { ok: false, error: '图片格式无效，仅支持 JPG / PNG / WEBP' });
  const mask = body.mask ? parseDataUrl(body.mask) : null;
  if (body.mask && !mask) return sendJson(res, 400, { ok: false, error: '遮罩数据无效' });

  const useMask = !!mask;
  const prompt = (typeof body.prompt === 'string' && body.prompt.trim())
    ? body.prompt.trim().slice(0, 400)
    : (useMask ? DEFAULT_PROMPT_MASK : DEFAULT_PROMPT_AUTO);

  const model = IMAGE_MODELS[body.model] ? body.model : DEFAULT_IMAGE_MODEL;
  const imgDataUrl = `data:${img.mime};base64,${img.base64}`;
  const maskDataUrl = mask ? `data:${mask.mime};base64,${mask.base64}` : null;

  try {
    // 首选用户选定的引擎；若被内容审核误伤，自动换引擎 + 保守提示词重试一次
    const order = [model, 'wanx2.1-imageedit', 'wan2.7-image-pro', 'qwen-image-3.0']
      .filter((m, i, arr) => IMAGE_MODELS[m] && arr.indexOf(m) === i);

    let image = null;
    let usedModel = model;
    let lastErr = null;
    let moderationHit = false;

    for (let i = 0; i < order.length; i++) {
      const m = order[i];
      const p = moderationHit ? SAFE_PROMPT_MASK : prompt;
      try {
        image = await runEdit(m, { imgDataUrl, maskDataUrl, prompt: p, useMask });
        usedModel = m;
        break;
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || e);
        if (isModerationError(msg)) {
          // 审核拦截：换下一个引擎继续试
          moderationHit = true;
          continue;
        }
        break; // 其他错误（额度/超时等）换引擎也没用，直接抛出
      }
    }

    if (!image) throw lastErr || new Error('图像处理失败');
    sendJson(res, 200, { ok: true, image, model: usedModel, fallback: usedModel !== model });
  } catch (e) {
    const raw = String(e.message || e);
    let friendly = raw;
    if (/Arrearage|AllocationQuota|quota/i.test(raw)) friendly = '当前 API 额度不足，请检查通义千问账号额度';
    else if (/InvalidApiKey|Unauthorized/i.test(raw)) friendly = 'API Key 无效，请检查配置';
    else if (/Throttling/i.test(raw)) friendly = '请求过于频繁，请稍等几秒后重试';
    else if (/abort/i.test(raw)) friendly = '网络超时，请重试';
    else if (/invalid header value|Headers\.append|Invalid character in header/i.test(raw)) {
      friendly = '服务端 API Key 配置异常（值里混入了换行或多余字符），请重新只填写以 sk- 开头的 Key';
    } else if (isModerationError(raw)) {
      friendly = '图片被内容安全审核拦截（含人物/皮肤的照片最容易误判），已自动尝试其他引擎仍未通过。建议：把标记框缩到只框住文字、换一张图，或先把人像区域裁掉再处理';
    }
    sendJson(res, 502, { ok: false, error: friendly, raw });
  }
}

async function handleDetect(req, res) {
  if (!KEY_OK) {
    return sendJson(res, 503, {
      ok: false,
      error: '服务端 DASHSCOPE_API_KEY 缺失或格式不合法（常见原因：把 .env 多行内容粘进了同一个变量），请只填写以 sk- 开头的一行 Key 后重新部署',
    });
  }
  if (isRateLimited(req)) {
    return sendJson(res, 429, { ok: false, error: `已超过每小时 ${RATE_LIMIT_PER_HOUR} 次的使用上限，请稍后再试` });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message || '请求体无效' });
  }
  const img = parseDataUrl(body.image);
  if (!img) return sendJson(res, 400, { ok: false, error: '图片格式无效，仅支持 JPG / PNG / WEBP' });
  const model = VISION_MODELS[body.model] ? body.model : 'qwen3.8-flash';

  try {
    const result = await visionDetect(model, `data:${img.mime};base64,${img.base64}`);
    if (!result.has) {
      return sendJson(res, 200, { ok: true, has: false, model });
    }
    sendJson(res, 200, { ok: true, has: true, box: result.box, model });
  } catch (e) {
    const raw = String(e.message || e);
    let friendly = raw;
    if (/Throttling/i.test(raw)) friendly = '定位请求过于频繁，请稍等几秒后重试';
    else if (/abort/i.test(raw)) friendly = '定位超时，请重试';
    else if (/invalid header value|Headers\.append|Invalid character in header/i.test(raw)) {
      friendly = '服务端 API Key 配置异常（值里混入了换行或多余字符），请重新只填写以 sk- 开头的 Key';
    }
    sendJson(res, 502, { ok: false, error: friendly, raw });
  }
}

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, p));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA 兜底到 index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = req.url || '/';
  try {
    if (req.method === 'POST' && u.startsWith('/api/remove')) {
      return await handleRemove(req, res);
    }
    if (req.method === 'POST' && u.startsWith('/api/detect')) {
      return await handleDetect(req, res);
    }
    if (req.method === 'GET' && u.startsWith('/api/health')) {
      return sendJson(res, 200, {
        ok: true,
        hasKey: Boolean(DASHSCOPE_KEY),
        keyOk: KEY_OK,
        keyWasSanitized: Boolean(RAW_KEY) && RAW_KEY.trim() !== DASHSCOPE_KEY,
        rateLimitPerHour: RATE_LIMIT_PER_HOUR,
        imageModels: Object.keys(IMAGE_MODELS),
        visionModels: Object.keys(VISION_MODELS),
      });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end('Method Not Allowed'); return;
    }
    serveStatic(req, res, u);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: '服务器内部错误' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[WatermarkZero] 服务已启动: http://localhost:${PORT}`);
  console.log(`[WatermarkZero] 去水印引擎: ${Object.keys(IMAGE_MODELS).join(', ')}`);
  console.log(`[WatermarkZero] 智能定位模型: ${Object.keys(VISION_MODELS).join(', ')}`);
});
