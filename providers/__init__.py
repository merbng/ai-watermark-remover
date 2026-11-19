"""Provider 工厂：按配置选择引擎。"""
import importlib
import config
from .base import BaseProvider

# 已实现的 provider 模块
_REGISTRY = {
    "mock": "providers.mock",
    "opencv": "providers.opencv_inpaint",
    "dashscope": "providers.dashscope",
    "openai": "providers.openai_compat",
}

# 别名，方便记忆
_ALIASES = {
    "qwen": "dashscope",
    "aliyun": "dashscope",
    "wanx": "dashscope",
    "openai-compatible": "openai",
    "compatible": "openai",
    "proxy": "openai",
    "cv": "opencv",
    "inpaint": "opencv",
    "free": "opencv",
    "none": "mock",
    "local": "mock",
}


def _resolve(name: str) -> str:
    name = (name or "").strip().lower()
    name = _ALIASES.get(name, name)
    if name not in _REGISTRY:
        raise ValueError(
            f"未知 provider: {name!r}。可选: {', '.join(sorted(_REGISTRY))} "
            f"（别名: {', '.join(sorted(_ALIASES))}）"
        )
    return name


def get_edit_provider() -> BaseProvider:
    return _create(_resolve(config.EDIT_PROVIDER))


def get_detect_provider() -> BaseProvider:
    return _create(_resolve(config.DETECT_PROVIDER))


def _create(name: str) -> BaseProvider:
    module = importlib.import_module(_REGISTRY[name])
    # 各模块统一暴露 create() 工厂
    return module.create()


def available() -> list:
    return sorted(_REGISTRY)
