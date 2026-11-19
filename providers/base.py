"""Provider 抽象基类。

所有 provider 都实现两个方法：
    detect(image_dataurl, model) -> dict   # 视觉定位，返回 {has, box, model}
    remove(image_dataurl, mask_dataurl, prompt, model) -> str  # 返回处理后图片 dataURL

这样 app.py 完全不关心底层是哪家厂商，换引擎只改一个环境变量。
"""
from abc import ABC, abstractmethod


class BaseProvider(ABC):
    name = "base"

    @abstractmethod
    def detect(self, image_dataurl: str, model: str = "") -> dict:
        """定位水印框。

        返回格式必须与前端 app.js 对齐：
            {"ok": True, "has": bool, "box": {"x0":..,"y0":..,"x1":..,"y1":..}, "model": str}
        box 为归一化坐标（0~1）。
        """
        raise NotImplementedError

    @abstractmethod
    def remove(self, image_dataurl: str, mask_dataurl: str,
               prompt: str, model: str = "") -> dict:
        """擦除水印。返回 {"image": <dataURL>, "model": <实际模型名>}。"""
        raise NotImplementedError
