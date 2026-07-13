#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test DashScope temporary upload policy endpoint (used by wan2.2-s2v).

Usage:
    python tools/test_dashscope_getpolicy.py --api-key sk-xxx
    python tools/test_dashscope_getpolicy.py --api-key sk-xxx --host dashscope.aliyuncs.com
    python tools/test_dashscope_getpolicy.py --api-key sk-xxx --host llm-xxxx.cn-beijing.maas.aliyuncs.com
"""
import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser(description="Test DashScope getPolicy endpoint")
    parser.add_argument("--api-key", required=True, help="DashScope API Key")
    parser.add_argument("--host", default="", help="API Host (optional)")
    parser.add_argument("--model", default="qwen-vl-plus", help="Model for policy")
    args = parser.parse_args()

    if args.host:
        os.environ["DASHSCOPE_API_HOST"] = args.host

    # Import after setting env so DASHSCOPE_HOST is computed correctly.
    from generate_video_cloud import DASHSCOPE_BASE, _get_upload_policy

    print(f"Testing getPolicy with base={DASHSCOPE_BASE}")
    try:
        policy = _get_upload_policy(args.api_key, model=args.model)
        print("SUCCESS: got upload policy")
        print(f"  upload_host={policy.get('upload_host')}")
        print(f"  upload_dir={policy.get('upload_dir')}")
        print(f"  oss_access_key_id={policy.get('oss_access_key_id')}")
        return 0
    except Exception as e:
        print(f"FAILED: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
