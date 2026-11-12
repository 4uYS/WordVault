#!/usr/bin/env bash
# 交叉编译 llama.cpp 与 JNI 推理层，产出各 ABI 的 libwordvault_llm.so
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/android-sdk}}"
NDK_VERSION="${NDK_VERSION:-27.2.12479018}"
NDK="$SDK/ndk/$NDK_VERSION"
LLAMA_VERSION="a691b2345844ce1b430201fc5fd404ce062e05f2"
LLAMA_SRC="$ANDROID_DIR/third_party/llama.cpp"
ABIS="${ABIS:-arm64-v8a x86_64}"
JOBS="${JOBS:-$(nproc)}"

if [ ! -d "$NDK" ]; then
  echo "未找到 NDK：$NDK" >&2
  echo "请先安装：sdkmanager \"ndk;$NDK_VERSION\"" >&2
  exit 1
fi

if [ ! -f "$LLAMA_SRC/CMakeLists.txt" ]; then
  echo "拉取 llama.cpp $LLAMA_VERSION ..."
  mkdir -p "$ANDROID_DIR/third_party"
  git clone https://github.com/ggml-org/llama.cpp.git "$LLAMA_SRC"
  git -C "$LLAMA_SRC" checkout "$LLAMA_VERSION"
  rm -rf "$LLAMA_SRC/.git"
fi

for ABI in $ABIS; do
  echo "构建 $ABI ..."
  BUILD_DIR="$ANDROID_DIR/build-native/$ABI"
  mkdir -p "$ANDROID_DIR/jniLibs/$ABI"
  cmake -S "$ANDROID_DIR/jni" -B "$BUILD_DIR" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI="$ABI" \
    -DANDROID_PLATFORM=android-24 \
    -DCMAKE_BUILD_TYPE=Release \
    -DANDROID_STL=c++_static
  cmake --build "$BUILD_DIR" --target wordvault_llm -j "$JOBS"
  cp "$BUILD_DIR/libwordvault_llm.so" "$ANDROID_DIR/jniLibs/$ABI/libwordvault_llm.so"
  STRIP="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip"
  if [ -x "$STRIP" ]; then
    "$STRIP" --strip-unneeded "$ANDROID_DIR/jniLibs/$ABI/libwordvault_llm.so"
  fi
  echo "  -> $ANDROID_DIR/jniLibs/$ABI/libwordvault_llm.so ($(du -h "$ANDROID_DIR/jniLibs/$ABI/libwordvault_llm.so" | cut -f1))"
done

echo "原生库构建完成"
