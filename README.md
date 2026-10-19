# WatermarkZero — AI 在线图片去水印（右下角 AI 生成标记专除）

仿照 watermarkzero.com 的「去除照片水印」单功能站点。功能范围：**只处理图片右下角的「AI生成 / 豆包AI生成」标记，画面其余区域一个像素都不改**。AI 能力接入**通义千问（DashScope）**，支持**多模型切换**。免费、无需登录。

## 运行

```bash
node server.js
# 默认 http://localhost:3777 （可用 PORT 环境变量覆盖）
```

无任何第三方依赖（纯 Node.js 内置模块，需 Node 18+）。

## 模型选择（全部经真实 API 验证可用）

**去水印引擎**（编辑器侧栏可切换，选择持久化在 localStorage）：

| 模型 | 接口 | 特点 |
|---|---|---|
| `wanx2.1-imageedit`（默认） | 异步 image-synthesis + 轮询 | 原生遮罩精修，约 15~40 秒 |
| `wan2.7-image-pro` | 同步 multimodal-generation | 极速，约 10~20 秒，遮罩以第二张图传入 |
| `Qwen-Image-3.0` | 同步 multimodal-generation | 2K 高清重建，约 40~80 秒 |

**智能定位模型**（多模态视觉理解，返回水印包围盒）：

`qwen3.8-flash`（推荐）/ `qwen3.8-max` / `qwen3.8-omni-flash` / `qwen3.8-27b` / `kimi-k3` / `qwen3.7-plus` / `qwen3.7-max-2026-06-08`；也可选「本地快速检测」（前端像素算法，瞬时、不耗额度）。

## 工作流程

1. **上传**：拖拽 / 点击选择，JPG / PNG / WEBP，≤ 20MB
2. **定位**：默认前端像素算法瞬时框选；选择视觉模型后自动改用 AI 定位（`POST /api/detect`，失败自动回退本地检测）；框体可拖动 / 四角缩放微调
3. **AI 擦除**（`POST /api/remove`，按所选模型路由）：
   - wanx2.1 → 整图 + 白 mask → `description_edit_with_mask`
   - wan2.7 / Qwen-Image-3.0 → 同步多模态，图片 + 遮罩图 + 指令
4. **像素级合成**：AI 重建结果只应用在框内（羽化边缘），框外保持原始分辨率原片像素；模型自己输出的角标也会因在框外而被自动丢弃
5. **对比 & 下载**：before/after 滑块，按原格式导出原始分辨率

## 配置

API Key 读取顺序：环境变量 `DASHSCOPE_API_KEY` → 项目根目录 `.env` 文件。首次运行：

```bash
cp .env.example .env
# 编辑 .env，填入 DASHSCOPE_API_KEY
```

`.env` 已在 `.gitignore` 中，不会被提交到 Git 仓库。

| 变量 | 说明 | 默认 |
|---|---|---|
| `DASHSCOPE_API_KEY` | 通义千问 DashScope 密钥（必填） | 无 |
| `RATE_LIMIT_PER_HOUR` | 每 IP 每小时调用上限，0 关闭 | 40 |
| `PORT` | 服务端口 | 3777 |

## 部署到公网

> 本项目包含 Node 后端（用于隐藏 API Key），**GitHub Pages 无法运行**，需要托管到支持 Node 的平台。

### 方式一：Render（推荐，免费额度足够）

1. 把仓库推到 GitHub
2. Render → New → Web Service → 选择该仓库
3. Build Command 留空，Start Command 填 `node server.js`
4. 在 Environment 里添加 `DASHSCOPE_API_KEY`
5. 部署完成后获得 `https://xxx.onrender.com` 链接

也可以直接用仓库里的 `render.yaml`（New → Blueprint）一键创建。

### 方式二：Railway / Fly.io / 云服务器

项目已带 `package.json`（`npm start` → `node server.js`）和 `Dockerfile`，任意支持 Node 18+ 或 Docker 的平台都能直接跑；平台注入的 `PORT` 会自动生效。

### 方式三：Docker 自托管

```bash
docker build -t watermark-zero .
docker run -p 8080:8080 -e DASHSCOPE_API_KEY=sk-xxx watermark-zero
```

公开部署时建议保留限流（`RATE_LIMIT_PER_HOUR`），避免链接被他人刷爆 API 额度。

## 结构

```
server.js          # 静态托管 + /api/remove（模型路由）+ /api/detect（视觉定位）
public/index.html  # 页面结构（含两个模型选择器）
public/style.css   # 暖米色 + 赤陶橙主题（复刻原站配色）
public/app.js      # 检测/框选/模型选择/送检/合成/对比滑块/下载逻辑
public/img/        # 效果展示样例（demo_before_* 带右下角标记，demo_after_* 为真实 AI 输出合成）
```
