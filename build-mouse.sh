#!/bin/bash
# 编译虚拟鼠标工具（macOS 自带 swiftc，零依赖；Windows 不需要）
set -e
cd "$(dirname "$0")"
if [ ! -f bin/pet-mouse ]; then
  mkdir -p bin
  swiftc -O tools/mouse.swift -o bin/pet-mouse
  echo "编译完成: bin/pet-mouse"
else
  echo "已存在: bin/pet-mouse"
fi
