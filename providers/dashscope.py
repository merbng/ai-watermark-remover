"""阿里云百炼（DashScope）provider。

- remove: 图像编辑走 wanx2.1-imageedit 系列（description_edit_with_mask）
- detect: 视觉定位走兼容 OpenAI 的 chat/completions（qwen-vl 系列返回坐标 JSON）

百炼图像编辑是异步任务：提交拿 task_id -> 轮询到 SUCCEEDED -> 下载结果图。
"""
import time
import requests

import config
from .base import BaseProvider
from utils import dataurl_to_png_bytes, to_dataurl, normalize_box, extract_json_object, parse_dataurl

DETECT_PROMPT = (
    "你是一个图像水印定位助手。图片右下角可能有「AI生成」「豆包AI生成」等文字标记"
    "（可能带小图标，白色实心或半透明）。请框出这个标记的紧凑边界框。"
    "只返回 JSON：{\"has\": true, \"box\": {\"x0\":0.85,\"y0\":0.90,\"x1\":0.98,\"y1\":0.98}}，"
    "坐标为相对图片宽高的 0~1 归一化值。若右下角没有此类标记，返回 {\"has\": false}。"
    "不要输出任何解释文字。"
)

# 前端模型名 -> 我方配置里的真实模型名
def _map_edit_model(front_model: str) -> str:
    m = (front_model or "").strip()
    if m == "wan2.7-image-pro":
        return config.DASHSCOPE_MODEL_FAST
    if m == "qwen-image-3.0":
        return config.DASHSCOPE_MODEL_HQ
    return config.DASHSCOPE_MODEL_DEFAULT


class DashScopeProvider(BaseProvider):
    name = "dashscope"

    def __init__(self):
        if not config.DASHSCOPE_API_KEY:
            raise RuntimeError("未配置 DASHSCOPE_API_KEY")
        self.key = config.DASHSCOPE_API_KEY
        self.base = config.DASHSCOPE_BASE_URL
        self.compat = config.DASHSCOPE_COMPAT_BASE_URL
        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {self.key}"})

    # ---------------- 视觉定位 ----------------
    def detect(self, image_dataurl: str, model: str = "") -> dict:
        vl_model = model if model and model != "local" else config.DASHSCOPE_VL_MODEL
        # 前端传的是 qwen3.x 这类名字，线上未必存在；统一回退到配置模型
        if not vl_model.startswith("qwen") or vl_model in (
            "qwen3.8-flash", "qwen3.8-max", "qwen3.8-omni-flash",
            "qwen3.8-27b", "qwen3.7-plus", "qwen3.7-max-2026-06-08", "kimi-k3"
        ):
            vl_model = config.DASHSCOPE_VL_MODEL
        payload = {
            "model": vl_model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": DETECT_PROMPT},
                    {"type": "image_url", "image_url": {"url": image_dataurl}},
                ],
            }],
            "temperature": 0,
        }
        r = self.s.post(f"{self.compat}/chat/completions",
                        json=payload, timeout=config.HTTP_TIMEOUT)
        r.raise_for_status()
        text = r.json()["choices"][0]["message"]["content"]
        obj = extract_json_object(text)
        if not obj or not obj.get("has"):
            return {"ok": True, "has": False, "box": None, "model": vl_model}
        box = normalize_box(obj.get("box"))
        return {"ok": True, "has": box is not None, "box": box, "model": vl_model}

    # ---------------- 图像擦除 ----------------
    def remove(self, image_dataurl: str, mask_dataurl: str,
               prompt: str, model: str = "") -> dict:
        real_model = _map_edit_model(model)
        img_png = dataurl_to_png_bytes(image_dataurl)
        mask_png = dataurl_to_png_bytes(mask_dataurl)

        submit = {
            "model": real_model,
            "input": {
                "function": "description_edit_with_mask",
                "source_image": to_dataurl(img_png, "image/png"),
                "mask_image": to_dataurl(mask_png, "image/png"),
                "prompt": prompt,
            },
            "parameters": {"n": 1},
        }
        headers = {"X-DashScope-Async": "enable"}
        r = self.s.post(f"{self.base}/services/aigc/image2image/image-synthesis",
                        json=submit, headers=headers, timeout=config.HTTP_TIMEOUT)
        r.raise_for_status()
        task_id = r.json().get("output", {}).get("task_id")
        if not task_id:
            raise RuntimeError(f"百炼未返回 task_id: {r.text[:300]}")

        result_url = self._poll_task(task_id)
        # 下载结果图 -> dataURL
        rr = requests.get(result_url, timeout=config.HTTP_TIMEOUT)
        rr.raise_for_status()
        mime = rr.headers.get("Content-Type", "image/png").split(";")[0].strip()
        return {"image": to_dataurl(rr.content, mime), "model": real_model}

    def _poll_task(self, task_id: str) -> str:
        deadline = time.time() + config.POLL_MAX_WAIT
        url = f"{self.base}/tasks/{task_id}"
        last_status = ""
        while time.time() < deadline:
            r = self.s.get(url, timeout=config.HTTP_TIMEOUT)
            r.raise_for_status()
            out = r.json().get("output", {})
            status = out.get("task_status", "")
            last_status = status
            if status == "SUCCEEDED":
                results = out.get("results") or []
                if results and results[0].get("url"):
                    return results[0]["url"]
                raise RuntimeError("任务成功但未返回结果图片")
            if status in ("FAILED", "CANCELLED"):
                msg = out.get("message") or out.get("error") or {}
                raise RuntimeError(f"图像编辑任务{status}: {msg}")
            time.sleep(config.POLL_INTERVAL)
        raise RuntimeError(f"图像编辑任务超时（最后状态: {last_status}）")


def create() -> BaseProvider:
    return DashScopeProvider()
