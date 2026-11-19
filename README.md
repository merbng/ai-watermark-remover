# WatermarkZero —— AI 图片去水印

专治图片右下角「AI生成 / 豆包AI生成」标记的在线去水印工具。前端从原线上站点
（`ai-watermark-remover-9a4l.onrender.com`）完整复原，后端重写为**可插拔引擎**架构。

核心机制：**AI 只重建标记框内的像素，框外与原图逐个像素完全一致**（这一保证由前端 canvas
合成实现，不依赖具体模型）。

---

## 一、项目结构

```
watermark-remover/
├── app.py                 # Flask 主服务：静态托管 + /api/detect + /api/remove
├── config.py              # 全部配置走环境变量
├── utils.py               # dataURL / 图片 / JSON 工具
├── providers/
│   ├── __init__.py        # 工厂：按配置选引擎
│   ├── base.py            # 抽象基类
│   ├── mock.py            # 假引擎（无需 Key，用于测试和演示）
│   ├── dashscope.py       # 阿里云百炼（原项目同款 wanx2.1-imageedit）
│   └── openai_compat.py   # OpenAI / OpenAI 兼容中转
├── static/                # 前端（已完整复原）
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── img/               # 8 张演示图
├── requirements.txt
├── .env.example           # 配置模板
├── Procfile               # Render 启动命令
└── render.yaml            # Render 声明式部署
```

---

## 二、快速开始（本地，无需任何 Key）

```bash
cd watermark-remover
pip install -r requirements.txt
python app.py
```

浏览器打开 `http://localhost:8000`。默认 `EDIT_PROVIDER=opencv`、`DETECT_PROVIDER=opencv`（本地免费引擎），
不配任何 Key 就能**真正擦掉水印**并把整套流程走通（上传 → 框选 → 擦除 → 对比 → 下载）。

> **免费引擎 `opencv`**：用 OpenCV 图像修复算法根据遮罩周围的像素重建标记区域，
> 完全离线、零成本、秒级完成。对右下角**纯色/渐变/简单纹理**背景的小标记效果好；
> 复杂纹理或大面积区域建议换生成式大模型（方案 A/B）。
> 若只想测 UI 流程不关心效果，可用 `EDIT_PROVIDER=mock`（原样返回）。

---

## 三、接入真实去水印能力（关键）

去水印分两步，要分清两种模型能力：

| 步骤 | 需要的模型能力 | 你的反代 `127.0.0.1:7863` |
|---|---|---|
| ① 定位水印框 | 视觉理解（图像**输入**，`text+image→text`） | ✅ **可用**（实测 `glm-5.3-flash` / `hy4flash` 均能准确返回框坐标） |
| ② 擦除重建 | 图像编辑（图**输出** / inpainting，`→image`） | ❌ 没有此类模型，图像端点返回 503 |

所以：**定位这步可以直接用你的反代**（已接好，见方案 C）；**擦除这步必须换一个支持图像编辑的引擎**（方案 A / B）。

### 方案 C：定位用你的反代 + 擦除用云端引擎（混搭，推荐）

两全其美：定位走你的免费反代，擦除走按量付费的云端图像编辑。

```bash
DETECT_PROVIDER=openai          # 定位 -> 你的反代
OPENAI_BASE_URL=http://127.0.0.1:7863/v1
OPENAI_API_KEY=WildWorkAPI
OPENAI_VL_MODEL_MAP={"qwen3.8-flash":"workbuddy/glm-5.3-flash","kimi-k3":"workbuddy/kimi-k3-1"}
DETECT_MAX_TOKENS=2000           # 强制推理模型要调大，否则正文为空

EDIT_PROVIDER=dashscope          # 擦除 -> 阿里云百炼（见方案 A）
DASHSCOPE_API_KEY=sk-xxxxxx
```

> 已实测：反代定位返回 `box {x0:0.92,y0:0.95,x1:0.99,y1:0.99}`，准确命中右下角水印。
> 部署到 Render 时，定位那步的 `127.0.0.1` 会失效（云端访问不到你本机），
> 需把 `DETECT_PROVIDER` 改为 `none`（用前端本地像素检测）或也换成云端视觉模型。

### 方案 A：阿里云百炼（推荐，原项目同款，国内直连）

1. 开通 https://bailian.console.aliyun.com/ ，在「API-Key 管理」创建 Key。
2. 确认账号可用模型：图像编辑 `wanx2.1-imageedit`（或 wanx2.1-imageedit 的更新版本），
   视觉定位 `qwen-vl-max-latest`。
3. 设置环境变量：

```bash
EDIT_PROVIDER=dashscope
DETECT_PROVIDER=dashscope       # 想省钱就用 none（走前端本地检测）
DASHSCOPE_API_KEY=sk-xxxxxx
DASHSCOPE_MODEL_DEFAULT=wanx2.1-imageedit
DASHSCOPE_MODEL_FAST=wanx2.1-imageedit
DASHSCOPE_MODEL_HQ=wanx2.1-imageedit
DASHSCOPE_VL_MODEL=qwen-vl-max-latest
```

### 方案 B：OpenAI / OpenAI 兼容中转

⚠️ **硬性要求**：中转必须实现 `POST /images/edits`（带 mask 的图像编辑）端点。
市面上很多廉价中转**只支持 chat/completions，不支持图像编辑**——这类用不了，
调用会返回 404（本程序会给出明确提示）。

```bash
EDIT_PROVIDER=openai
DETECT_PROVIDER=openai          # 或 none
OPENAI_API_KEY=sk-xxxxxx
OPENAI_BASE_URL=https://api.openai.com/v1   # 中转就填它的 OpenAI 兼容地址
OPENAI_EDIT_MODEL=gpt-image-1
OPENAI_VL_MODEL=gpt-4o-mini
```

> 关于 `127.0.0.1:7863` 这类本机反代：即使它支持图像编辑，`127.0.0.1` 也**只在你的电脑上有效**。
> 一旦部署到 Render，服务器访问 `127.0.0.1` 指的是它自己，连不到你的反代。
> 所以云端部署只能用**公网可达**的真实 API（阿里云百炼 / 官方 OpenAI 等）。

### 环境变量速查

| 变量 | 说明 | 默认 |
|---|---|---|
| `EDIT_PROVIDER` | 擦除引擎 `mock/dashscope/openai` | `mock` |
| `DETECT_PROVIDER` | 定位引擎 `mock/dashscope/openai/none` | `mock` |
| `DASHSCOPE_API_KEY` | 百炼 Key | 空 |
| `OPENAI_API_KEY` | OpenAI Key | 空 |
| `OPENAI_BASE_URL` | 中转地址 | 官方 |
| `OPENAI_EDIT_MODEL` | 图像编辑模型 | `gpt-image-1` |
| `PORT` | 监听端口 | `8000` |

---

## 四、部署到 Render

### 方式一：GitHub 自动部署（最省事，推荐）

1. 把本目录推到你的 GitHub 仓库（含 `render.yaml`）。
2. Render 控制台 → **New** → **Blueprint** → 连接该仓库 → 自动识别 `render.yaml`。
3. 在服务的 **Environment** 页里把 `EDIT_PROVIDER` 改成 `dashscope` 或 `openai`，
   并添加对应的 API Key 环境变量（**不要**把 Key 写进代码或 render.yaml）。
4. 保存后自动构建部署，访问分配的 `onrender.com` 域名即可。

### 方式二：手动创建 Web Service

1. Render → **New** → **Web Service** → 连接仓库。
2. Environment: `Python 3`，Build: `pip install -r requirements.txt`，
   Start: `gunicorn app:app -b 0.0.0.0:$PORT --timeout 300 --workers 1`。
3. 同样在 Environment 页配好引擎和 Key。
4. Health Check Path 填 `/api/health`。

> ⚠️ Render 免费套餐会在闲置约 15 分钟后休眠，首次访问需冷启动几十秒——这是正常现象。
> 图像编辑任务较慢，`--timeout 300` 已相应放宽。

---

## 五、API 契约（供二次开发）

**POST /api/detect** — 视觉定位
```json
请求: {"image": "data:image/jpeg;base64,...", "model": "qwen3.8-flash"}
响应: {"ok": true, "has": true, "box": {"x0":0.85,"y0":0.9,"x1":0.98,"y1":0.98}, "model": "qwen-vl-max-latest"}
```
box 为 0~1 归一化坐标。

**POST /api/remove** — 图像擦除
```json
请求: {"image": "data:image/jpeg;base64,...", "mask": "data:image/png;base64,...",
       "prompt": "...", "model": "wanx2.1-imageedit"}
响应: {"ok": true, "image": "data:image/png;base64,...", "model": "wanx2.1-imageedit"}
```
mask 是前端生成的白色矩形（标记框区域），provider 据此只重绘框内。

**GET /api/health** — 健康检查（返回当前引擎配置和 Key 是否已设置，脱敏）

---

## 六、新增一种引擎

1. 在 `providers/` 新建模块，继承 `BaseProvider`，实现 `detect()` 和 `remove()`。
2. 在 `providers/__init__.py` 的 `_REGISTRY` 注册名字。
3. 在 `config.py` 加对应配置项，在 `.env.example` 里补充示例。
4. 把 `EDIT_PROVIDER` / `DETECT_PROVIDER` 设为新名字即可。前端完全不用改。
