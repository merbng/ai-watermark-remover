"""WatermarkZero 后端服务。

职责：
1. 托管 static/ 下的前端（HTML/CSS/JS/演示图）
2. 提供两个 API：
   - POST /api/detect  视觉定位水印框
   - POST /api/remove  图像编辑擦除水印
3. 引擎可插拔，前端无感知

本地运行：  python app.py
生产部署：  gunicorn app:app -b 0.0.0.0:$PORT
"""
import os
import traceback
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

import config
from providers import get_edit_provider, get_detect_provider

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = config.MAX_CONTENT_LENGTH
CORS(app)  # 允许前端在其它端口/域名调试时跨域调用

# provider 惰性初始化：配置错误时在首次调用才报错，便于 /api/health 仍能启动
_edit = None
_detect = None


def edit_provider():
    global _edit
    if _edit is None:
        _edit = get_edit_provider()
    return _edit


def detect_provider():
    global _detect
    if _detect is None:
        _detect = get_detect_provider()
    return _detect


def ok(**kwargs):
    return jsonify({"ok": True, **kwargs})


def fail(msg, code=200):
    # 前端按 data.ok 判断，故业务错误默认仍返回 200 + ok:false
    return jsonify({"ok": False, "error": str(msg)}), code


# ---------------- 静态文件 ----------------
@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    # 防止路径穿越
    target = (STATIC_DIR / filename).resolve()
    if STATIC_DIR.resolve() not in target.parents and target != STATIC_DIR.resolve():
        return fail("非法路径", 403)
    if target.is_file():
        return send_from_directory(STATIC_DIR, filename)
    return fail("Not Found", 404)


# ---------------- 健康检查 ----------------
@app.route("/api/health")
def health():
    return ok(service="WatermarkZero", **config.describe())


# ---------------- 视觉定位 ----------------
@app.route("/api/detect", methods=["POST"])
def api_detect():
    try:
        body = request.get_json(force=True, silent=True) or {}
        image = body.get("image")
        model = body.get("model", "")
        if not image:
            return fail("缺少 image 参数")
        if config.DETECT_PROVIDER in ("none", "local"):
            # 让前端回退到本地像素检测
            return ok(has=False, box=None, model="local")
        result = detect_provider().detect(image, model)
        if not result.get("ok"):
            return fail(result.get("error", "定位失败"))
        return ok(has=result.get("has", False), box=result.get("box"),
                  model=result.get("model", config.DETECT_PROVIDER))
    except Exception as e:
        traceback.print_exc()
        # 定位失败不应阻断主流程：告诉前端没有框，它会自动用本地检测
        return ok(has=False, box=None, model="fallback", error=str(e))


# ---------------- 图像擦除 ----------------
@app.route("/api/remove", methods=["POST"])
def api_remove():
    try:
        body = request.get_json(force=True, silent=True) or {}
        image = body.get("image")
        mask = body.get("mask")
        prompt = body.get("prompt", "")
        model = body.get("model", "")
        if not image or not mask:
            return fail("缺少 image 或 mask 参数")
        result = edit_provider().remove(image, mask, prompt, model)
        return ok(image=result["image"], model=result.get("model", config.EDIT_PROVIDER))
    except Exception as e:
        traceback.print_exc()
        return fail(e)


# ---------------- 启动 ----------------
if __name__ == "__main__":
    print("=" * 60)
    print("  WatermarkZero backend")
    print(f"  edit provider  : {config.EDIT_PROVIDER}")
    print(f"  detect provider: {config.DETECT_PROVIDER}")
    print(f"  listening on   : 0.0.0.0:{config.PORT}")
    print("=" * 60)
    app.run(host="0.0.0.0", port=config.PORT, debug=False)
