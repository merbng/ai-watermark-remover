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

# 前端模型名 -> 真正用于"带遮罩局部擦除"的模型。
#
# 实测结论（2026-11-19，用本账号 Key）：
#   - 只有 wanx2.1-imageedit 走 description_edit_with_mask 能干净擦除水印（框外零改动）。
#   - 前端列出的文生图/涂鸦模型（z-image-turbo、qwen-image-2.1-pro、wan2.7-image*、
#     wanx-sketch-to-image-lite 等）走的是各自专属接口，不支持带遮罩编辑，直接调用会报错。
#   - qwen-mt-image* 实为翻译模型，提交成功但执行时报缺 source_lang/target_lang。
# 因此这里做"智能回退"：非 wanx2.1-imageedit 的选项一律映射到真正能干活的模型，
# 保证用户点任意选项都能得到正常的擦除结果，而不是拿到一条报错。
_EDIT_MODEL_CAPABLE = {"wanx2.1-imageedit"}

def _map_edit_model(front_model: str) -> str:
    m = (front_model or "").strip()
    if m in _EDIT_MODEL_CAPABLE:
        return m
    # 其余模型名（含下发的免费试用清单）回退到实测可用的图像编辑模型
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
    # 实测可用的视觉定位模型（本账号 Key，走 compatible-mode chat/completions）。
    # 其它模型名一律回退到 DASHSCOPE_VL_MODEL，避免 access_denied / model_not_found。
    _VL_CAPABLE = {
        "qwen3.8-flash", "qwen3.8-max", "qwen3.8-omni-flash",
        "qwen-vl-ocr", "qwen3.7-flash", "qwen3.7-plus",
    }

    def detect(self, image_dataurl: str, model: str = "") -> dict:
        requested = (model or "").strip()
        vl_model = requested if requested and requested != "local" else config.DASHSCOPE_VL_MODEL
        if vl_model not in self._VL_CAPABLE:
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
                # 百炼 image-synthesis 的正确字段名是 base_image_url / mask_image_url，
                # 且分辨率需在 512~4096 —— 前端已按最长边 1600 送检，满足要求。
                "base_image_url": to_dataurl(img_png, "image/png"),
                "mask_image_url": to_dataurl(mask_png, "image/png"),
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
