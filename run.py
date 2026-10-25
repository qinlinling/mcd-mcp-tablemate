#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""麦麦同席 · 启动入口。

    python run.py            默认 http://127.0.0.1:8848
    python run.py 9000       指定端口

只用 Python 标准库，不需要 pip install。
"""
import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.server import serve  # noqa: E402


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def main():
    try:
        start = int(sys.argv[1]) if len(sys.argv) > 1 else 8848
    except ValueError:
        raise SystemExit("端口需要是数字，例如：python run.py 8848")
    if not (1 <= start <= 65535):
        raise SystemExit("端口需在 1—65535 之间")
    port = start
    for _ in range(20):
        if port_free(port):
            break
        port += 1
    else:
        raise SystemExit("找不到可用端口，请手动指定：python run.py <端口>")
    if port != start:
        print("端口 %d 被占用，自动改用 %d" % (start, port))
    serve(port=port)


if __name__ == "__main__":
    main()
