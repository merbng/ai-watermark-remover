"""全局配置：全部通过环境变量读取，便于在本地 / Render 间切换而无需改代码。

真正决定"用哪个引擎干活"的只有两个变量：
    EDIT_PROVIDER   -> 图像擦除引擎：mock | dashscope | openai
    DETECT_PROVIDER -> 视觉定位引擎：mock | dashscope | openai | none

前端下拉框里的模型名（wanx2.1-imageedit / qwen3.8-flash 等）会作为参数透传给
provider，由 provider 决定如何映射到你账号里真实可用的模型。
"""
import os


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


# ---------- 引擎选择 ----------
EDIT_PROVIDER = os.getenv("EDIT_PROVIDER", "opencv").strip().lower()
DETECT_PROVIDER = os.getenv("DETECT_PROVIDER", "opencv").strip().lower()

# ---------- 阿里云百炼（DashScope）----------
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "").strip()
DASHSCOPE_BASE_URL = os.getenv(
    "DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/api/v1"
).rstrip("/")
# 兼容 OpenAI 的端点（用于视觉定位 / 也可用于图像编辑）
DASHSCOPE_COMPAT_BASE_URL = os.getenv(
    "DASHSCOPE_COMPAT_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"
).rstrip("/")
# 三个档位映射到你账号里真实可用的图像编辑模型名
DASHSCOPE_MODEL_DEFAULT = os.getenv("DASHSCOPE_MODEL_DEFAULT", "wanx2.1-imageedit")
DASHSCOPE_MODEL_FAST = os.getenv("DASHSCOPE_MODEL_FAST", "wanx2.1-imageedit")
DASHSCOPE_MODEL_HQ = os.getenv("DASHSCOPE_MODEL_HQ", "wanx2.1-imageedit")
# 视觉定位模型
DASHSCOPE_VL_MODEL = os.getenv("DASHSCOPE_VL_MODEL", "qwen-vl-max-latest")

# ---------- OpenAI 兼容（官方 / 任何中转）----------
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
OPENAI_EDIT_MODEL = os.getenv("OPENAI_EDIT_MODEL", "gpt-image-1")
OPENAI_VL_MODEL = os.getenv("OPENAI_VL_MODEL", "gpt-4o-mini")
# 前端历史模型名 -> 反代真实模型的映射（JSON 字符串）。
# 例：{"qwen3.8-flash":"workbuddy/glm-5.3-flash","kimi-k3":"workbuddy/kimi-k3-1"}
OPENAI_VL_MODEL_MAP = os.getenv("OPENAI_VL_MODEL_MAP", "").strip()
# 视觉定位 max_tokens：强制推理模型需要更大预算，否则正文为空
DETECT_MAX_TOKENS = _int("DETECT_MAX_TOKENS", 2000)

# ---------- 服务参数 ----------
PORT = _int("PORT", 8000)
MAX_CONTENT_LENGTH = _int("MAX_CONTENT_LENGTH", 32 * 1024 * 1024)  # 32MB
HTTP_TIMEOUT = _int("HTTP_TIMEOUT", 180)          # 单次上游请求超时（秒）
POLL_INTERVAL = float(os.getenv("POLL_INTERVAL", "2"))   # 异步任务轮询间隔
POLL_MAX_WAIT = _int("POLL_MAX_WAIT", 300)        # 异步任务最长等待（秒）


def edit_provider_name() -> str:
    return EDIT_PROVIDER


def detect_provider_name() -> str:
    return DETECT_PROVIDER


def describe() -> dict:
    """给 /api/health 用的脱敏配置摘要。"""
    return {
        "edit_provider": EDIT_PROVIDER,
        "detect_provider": DETECT_PROVIDER,
        "dashscope_key_set": bool(DASHSCOPE_API_KEY),
        "openai_key_set": bool(OPENAI_API_KEY),
    }
