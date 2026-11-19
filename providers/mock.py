"""Mock provider：不需要任何 API Key，用于本地打通全流程 / 前端联调。

行为：
- detect: 返回右下角一个默认框（has=False，让前端回退到本地检测提示）
- remove: 原样返回传入的图片（前端仍会走完整的"框内合成 + 对比 + 下载"流程）

这样即使没配任何 Key，也能验证前后端接口、UI 交互、下载全部正常。
"""
from .base import BaseProvider


class MockProvider(BaseProvider):
    name = "mock"

    def detect(self, image_dataurl: str, model: str = "") -> dict:
        return {
            "ok": True,
            "has": False,
            "box": None,
            "model": "mock",
        }

    def remove(self, image_dataurl: str, mask_dataurl: str,
               prompt: str, model: str = "") -> dict:
        # 原图返回——前端会拿它做"框内替换"，效果等同未擦除，但流程完整可测
        return {"image": image_dataurl, "model": "mock"}


def create() -> BaseProvider:
    return MockProvider()
