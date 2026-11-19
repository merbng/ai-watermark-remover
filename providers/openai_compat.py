"""OpenAI 兼容 provider —— 官方 OpenAI 或任何实现了 OpenAI 接口格式的中转都可用。

- remove: 走 POST {BASE_URL}/images/edits（gpt-image-1 / dall-e-2 等支持 mask 的模型）
- detect: 走 POST {BASE_URL}/chat/completions（视觉模型返回坐标 JSON）

注意：很多廉价中转只实现了 chat/completions，没有 /images/edits 端点。
如果 remove 报 404，说明该中转不支持图像编辑，需要换支持图像生成的渠道。
"""
import requests

import config
from .base import BaseProvider
from utils import dataurl_to_png_bytes, to_dataurl, parse_dataurl, normalize_box, extract_json_object

DETECT_PROMPT = (
    "You are an image watermark detector. In the BOTTOM-RIGHT corner there may be a "
    "marker like \"AI生成\" / \"豆包AI生成\" (possibly with a small icon, white solid or "
    "semi-transparent). Return the tight bounding box of that marker. "
    "Reply ONLY JSON: {\"has\": true, \"box\": {\"x0\":0.85,\"y0\":0.90,\"x1\":0.98,\"y1\":0.98}} "
    "with coordinates normalized 0~1 to image width/height. If none, reply {\"has\": false}. "
    "No explanation."
)


class OpenAIProvider(BaseProvider):
    name = "openai"

    def __init__(self):
        if not config.OPENAI_API_KEY:
            raise RuntimeError("未配置 OPENAI_API_KEY")
        self.key = config.OPENAI_API_KEY
        self.base = config.OPENAI_BASE_URL
        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {self.key}"})

    # ---------------- 视觉定位 ----------------
    def _resolve_vl_model(self, front_model: str) -> str:
        """前端下拉框里的历史模型名（qwen3.x / kimi-k3 等）映射到当前账号真实可用的模型。

        映射规则：
        1. 若配置了 OPENAI_VL_MODEL_MAP（JSON，如 {\"qwen3.8-flash\":\"workbuddy/glm-5.3-flash\"}）优先用它；
        2. 否则若前端传的模型名在当前渠道可用，直接用；
        3. 否则回退到 OPENAI_VL_MODEL。
        """
        import json
        front = (front_model or "").strip()
        custom_map = {}
        if getattr(config, "OPENAI_VL_MODEL_MAP", ""):
            try:
                custom_map = json.loads(config.OPENAI_VL_MODEL_MAP)
            except Exception:
                custom_map = {}
        if front in custom_map:
            return custom_map[front]
        if front:  # 前端名字若能直接用（很多人把中转模型名填进下拉框），尊重它
            return front
        return config.OPENAI_VL_MODEL

    def detect(self, image_dataurl: str, model: str = "") -> dict:
        vl_model = self._resolve_vl_model(model)
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
            # 强制推理型模型（如 workbuddy/hy4flash）会先吐一大段 reasoning，
            # token 给少了正文就是空的——给足预算。
            "max_tokens": getattr(config, "DETECT_MAX_TOKENS", 2000),
        }
        r = self.s.post(f"{self.base}/chat/completions",
                        json=payload, timeout=config.HTTP_TIMEOUT)
        r.raise_for_status()
        msg = r.json()["choices"][0]["message"]
        text = msg.get("content") or ""
        # 有些渠道只把结果放在 reasoning_content 里（或正文为空时回退读它）
        if not text.strip():
            text = msg.get("reasoning_content") or ""
        obj = extract_json_object(text)
        if not obj or not obj.get("has"):
            return {"ok": True, "has": False, "box": None, "model": vl_model}
        box = normalize_box(obj.get("box"))
        return {"ok": True, "has": box is not None, "box": box, "model": vl_model}

    # ---------------- 图像擦除 ----------------
    def remove(self, image_dataurl: str, mask_dataurl: str,
               prompt: str, model: str = "") -> dict:
        model_used = config.OPENAI_EDIT_MODEL
        img_png = dataurl_to_png_bytes(image_dataurl)
        mask_png = dataurl_to_png_bytes(mask_dataurl)

        # gpt-image-1 用 multipart；响应默认返回 b64_json
        files = {
            "image": ("source.png", img_png, "image/png"),
            "mask": ("mask.png", mask_png, "image/png"),
        }
        data = {
            "model": model_used,
            "prompt": prompt,
            "n": "1",
            "response_format": "b64_json",
            "size": "auto",
        }
        r = self.s.post(f"{self.base}/images/edits",
                        files=files, data=data, timeout=config.HTTP_TIMEOUT)
        if r.status_code == 404:
            raise RuntimeError(
                "当前中转不支持 /images/edits 图像编辑端点（404）。"
                "请换用支持图像生成/编辑的渠道（如官方 OpenAI 或阿里云百炼）。"
            )
        r.raise_for_status()
        resp = r.json()
        item = (resp.get("data") or [{}])[0]
        if item.get("b64_json"):
            out = to_dataurl(
                __import__("base64").b64decode(item["b64_json"]), "image/png"
            )
        elif item.get("url"):
            rr = requests.get(item["url"], timeout=config.HTTP_TIMEOUT)
            rr.raise_for_status()
            out = to_dataurl(rr.content, "image/png")
        else:
            raise RuntimeError(f"图像编辑未返回图片: {r.text[:300]}")
        return {"image": out, "model": model_used}


def create() -> BaseProvider:
    return OpenAIProvider()
