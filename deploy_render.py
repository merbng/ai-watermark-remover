#!/usr/bin/env python3
"""用 Render API 从 GitHub Blueprint 部署本服务。

用法：
    RENDER_API_KEY=rnd_xxxxx python deploy_render.py

可选参数：
    python deploy_render.py --key rnd_xxxxx --list        # 只列出已有服务
    python deploy_render.py --key rnd_xxxxx --delete-old   # 删除旧的 ai-watermark-remover 服务后再部署
"""
import argparse
import os
import sys
import time
import json
import urllib.request
import urllib.error

API = "https://api.render.com/v1"
REPO = "https://github.com/merbng/ai-watermark-remover"
BRANCH = "main"
SERVICE_NAME = "ai-watermark-remover"


def api(path, key, method="GET", body=None):
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "[]")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return -1, str(e)


def list_services(key):
    code, data = api("/services", key)
    if code != 200:
        print(f"[列出服务失败] HTTP {code}: {data}")
        return []
    services = []
    for item in data:
        s = item.get("service", item)
        services.append(s)
        print(f"  - {s.get('name')} | {s.get('slug')} | {s.get('type')} | {s.get('status')} | {s.get('serviceDetails',{}).get('url','')}")
    return services


def delete_service(key, service_id):
    print(f"删除旧服务 {service_id} ...")
    code, data = api(f"/services/{service_id}", key, method="DELETE")
    print(f"  HTTP {code}: {str(data)[:200]}")
    return code in (200, 204)


def deploy(key):
    print("=== 1. 检查已有服务 ===")
    services = list_services(key)
    old = [s for s in services if s.get("name") == SERVICE_NAME]

    if old:
        print(f"\n发现 {len(old)} 个同名服务 '{SERVICE_NAME}'。")
        for s in old:
            print(f"  id={s.get('id')} slug={s.get('slug')} url={s.get('serviceDetails',{}).get('url','')}")
        print("如需覆盖，请先用 --delete-old 删除，或在 Render Dashboard 手动删除。")
        print("本次将尝试创建 Blueprint（若名字冲突会失败）。")

    print("\n=== 2. 用 Blueprint 部署 ===")
    body = {
        "name": SERVICE_NAME,
        "repo": REPO,
        "branch": BRANCH,
        "autoDeploy": "yes",
    }
    print("请求体:", json.dumps(body, ensure_ascii=False))
    code, data = api("/blueprints", key, method="POST", body=body)
    print(f"HTTP {code}")
    print(json.dumps(data, ensure_ascii=False, indent=2)[:2000])

    if code in (200, 201, 202):
        print("\n✅ Blueprint 部署已提交！")
        print("服务通常 2-5 分钟完成构建。访问 Render Dashboard 查看进度。")
        print("线上地址格式: https://ai-watermark-remover.onrender.com")
        return data
    else:
        print("\n❌ 部署失败，请检查 Token 权限 / 仓库连接 / 名字冲突。")
        return None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--key", default=os.getenv("RENDER_API_KEY", ""), help="Render API Key")
    p.add_argument("--list", action="store_true", help="只列出服务")
    p.add_argument("--delete-old", action="store_true", help="删除同名旧服务")
    args = p.parse_args()

    if not args.key:
        print("请提供 Render API Key：RENDER_API_KEY=xxx python deploy_render.py 或 --key xxx")
        sys.exit(1)

    if args.list:
        list_services(args.key)
        return

    if args.delete_old:
        services = list_services(args.key)
        for s in services:
            if s.get("name") == SERVICE_NAME:
                delete_service(args.key, s.get("id"))
        return

    deploy(args.key)


if __name__ == "__main__":
    main()
