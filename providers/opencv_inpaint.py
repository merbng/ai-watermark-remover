"""OpenCV 本地图像修复 provider —— 完全免费、无需 Key、离线可用。

原理：用 OpenCV 的 Navier-Stokes / Telea 图像修复算法，根据遮罩区域周围的像素
向框内扩散填充，从而"擦掉"右下角的 AI 生成标记。这是传统 CV 算法，不是大模型，
但对右下角小面积、纯色/渐变/简单纹理背景的标记效果不错，且零成本、秒级完成。

优点：
- 无需任何 API Key、无需联网，开箱即用
- 速度快（通常 < 1 秒）

局限：
- 大面积或复杂纹理（密集纹理、人脸、文字叠加）区域，效果不如生成式大模型
- 修复结果是"周围像素插值"，不会凭空"理解"内容

适合：本地验证端到端流程、作为免费兜底引擎、处理简单的纯色/渐变背景标记。
"""
import base64
import io

import cv2
import numpy as np
from PIL import Image

from .base import BaseProvider
from utils import parse_dataurl, to_dataurl, normalize_box

# 修复半径（像素，相对缩略图）；越大越平滑但可能拖尾
INPAINT_RADIUS = 5
# inpaint 算法：cv2.INPAINT_TELEA（快）或 cv2.INPAINT_NS（Navier-Stokes）
INPAINT_METHOD = cv2.INPAINT_TELEA


class OpenCvInpaintProvider(BaseProvider):
    name = "opencv"

    def detect(self, image_dataurl: str, model: str = "") -> dict:
        """本地像素检测：识别右下角白色/低饱和文字标记（与前端 autoDetect 同思路）。
        返回归一化框。若找不到就 has=False，让前端回退默认框。"""
        _, raw = parse_dataurl(image_dataurl)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        w, h = img.size
        arr = np.asarray(img)
        # 搜索右下 40% x 20%
        x0s, y0s = int(w * 0.60), int(h * 0.80)
        region = arr[y0s:h, x0s:w]
        r, g, b = region[:, :, 0].astype(int), region[:, :, 1].astype(int), region[:, :, 2].astype(int)
        mx = np.maximum(np.maximum(r, g), b)
        mn = np.minimum(np.minimum(r, g), b)
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        thresh = max(145, min(int(lum.mean()) + 30, 200))
        mask = (mn > thresh) & ((mx - mn) < 80)
        if mask.sum() < max(24, region.shape[0] * region.shape[1] * 0.0012):
            return {"ok": True, "has": False, "box": None, "model": "opencv-local"}

        cols = np.where(mask.sum(axis=0) >= 2)[0]
        rows = np.where(mask.sum(axis=1) >= 2)[0]
        if len(cols) == 0 or len(rows) == 0:
            return {"ok": True, "has": False, "box": None, "model": "opencv-local"}
        bx0, bx1 = cols.min() + x0s, cols.max() + x0s
        by0, by1 = rows.min() + y0s, rows.max() + y0s
        bw, bh = bx1 - bx0, by1 - by0
        if bw < w * 0.02 or bh < h * 0.012 or bw > w * 0.5 or bh > h * 0.18:
            return {"ok": True, "has": False, "box": None, "model": "opencv-local"}

        pad = max(5, int(w * 0.012))
        box = normalize_box({
            "x0": max(0, (bx0 - bw * 0.18 - pad) / w),
            "y0": max(0, (by0 - bh * 0.25 - pad) / h),
            "x1": min(1, (bx1 + pad) / w),
            "y1": min(1, (by1 + pad) / h),
        })
        return {"ok": True, "has": box is not None, "box": box, "model": "opencv-local"}

    def remove(self, image_dataurl: str, mask_dataurl: str,
               prompt: str, model: str = "") -> dict:
        """用 OpenCV inpaint 根据 mask 修复图像。"""
        _, img_raw = parse_dataurl(image_dataurl)
        _, mask_raw = parse_dataurl(mask_dataurl)
        img = Image.open(io.BytesIO(img_raw)).convert("RGB")
        mask_img = Image.open(io.BytesIO(mask_raw)).convert("L")

        bgr = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)
        mask_arr = np.asarray(mask_img)
        # 放大遮罩确保覆盖标记；二值化
        _, mask_bin = cv2.threshold(mask_arr, 10, 255, cv2.THRESH_BINARY)
        # 轻微膨胀，避免边缘残留
        kernel = np.ones((3, 3), np.uint8)
        mask_bin = cv2.dilate(mask_bin, kernel, iterations=1)

        out = cv2.inpaint(bgr, mask_bin, INPAINT_RADIUS, INPAINT_METHOD)
        out_rgb = cv2.cvtColor(out, cv2.COLOR_BGR2RGB)
        buf = io.BytesIO()
        Image.fromarray(out_rgb).save(buf, format="PNG")
        return {"image": to_dataurl(buf.getvalue(), "image/png"), "model": "opencv-inpaint"}


def create() -> BaseProvider:
    return OpenCvInpaintProvider()
