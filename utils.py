"""dataURL 相关工具函数。"""
import base64
import re
from PIL import Image
import io

_DATAURL_RE = re.compile(r"^data:(?P<mime>[^;]+)(?:;charset=[^;]+)?;base64,(?P<data>.*)$", re.S)


def parse_dataurl(dataurl: str):
    """把 data:image/png;base64,xxx 解析成 (mime, bytes)。"""
    if not isinstance(dataurl, str):
        raise ValueError("dataURL 必须是字符串")
    m = _DATAURL_RE.match(dataurl)
    if not m:
        raise ValueError("不是合法的 base64 dataURL")
    mime = m.group("mime")
    raw = base64.b64decode(m.group("data"))
    return mime, raw


def to_dataurl(data: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def dataurl_to_png_bytes(dataurl: str, max_side: int | None = None) -> bytes:
    """把 dataURL 统一转成 PNG 字节；可选按最长边缩放（OpenAI edits 要求 PNG+方形/特定尺寸）。"""
    _, raw = parse_dataurl(dataurl)
    img = Image.open(io.BytesIO(raw)).convert("RGBA")
    if max_side:
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def normalize_box(box) -> dict | None:
    """校验并把框裁剪到 0~1，返回标准 dict；非法返回 None。"""
    try:
        x0, y0, x1, y1 = (float(box["x0"]), float(box["y0"]),
                          float(box["x1"]), float(box["y1"]))
    except (KeyError, TypeError, ValueError):
        return None
    # 允许模型返回顺序颠倒，做纠正
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    x0, y0 = max(0.0, min(1.0, x0)), max(0.0, min(1.0, y0))
    x1, y1 = max(0.0, min(1.0, x1)), max(0.0, min(1.0, y1))
    if (x1 - x0) < 0.005 or (y1 - y0) < 0.005:
        return None
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def extract_json_object(text: str) -> dict | None:
    """从模型回复里抠出第一个 JSON 对象（容忍 ```json 包裹 / 前后废话）。"""
    if not text:
        return None
    text = text.strip()
    # 去掉 markdown code fence
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    # 找第一个 { ... 到匹配的 }
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                candidate = text[start:i + 1]
                try:
                    import json
                    obj = json.loads(candidate)
                    return obj if isinstance(obj, dict) else None
                except Exception:
                    return None
    return None
