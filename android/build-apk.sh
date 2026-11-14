#!/usr/bin/env bash
# 将 dist-single/index.html 打包为可安装的 Android APK（纯 WebView 外壳，完全离线）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT/android"

# d8 / apksigner 对 JDK 版本敏感，优先使用 JAVA_HOME 指定的 JDK（建议 17）
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/javac" ]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/android-sdk}}"
BUILD_TOOLS="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
INPUT_HTML="$ROOT/dist-single/index.html"
OUT_DIR="$ROOT/dist-android"
BUILD_DIR="$ANDROID_DIR/build"
APK_NAME="${APK_NAME:-WordVault.apk}"
APK_VERSION="${APK_VERSION:-1.0.0}"
APK_VERSION_CODE="${APK_VERSION_CODE:-1}"
# 可通过 ABIS 只打包指定 ABI（例如 ABIS=arm64-v8a 得到更小的分发包）
ABIS="${ABIS:-arm64-v8a,x86_64}"
KEY_ALIAS="${KEY_ALIAS:-wordvault}"
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:-wordvault}"

# CI 可通过 secret 注入固定密钥（base64），保证升级覆盖安装时签名一致
if [ -n "${WV_KEYSTORE_BASE64:-}" ]; then
  mkdir -p "$ANDROID_DIR/keystore"
  printf '%s' "$WV_KEYSTORE_BASE64" | base64 -d > "$ANDROID_DIR/keystore/wordvault.keystore"
fi

for tool in aapt2 d8 zipalign apksigner; do
  if [ ! -x "$BUILD_TOOLS/$tool" ]; then
    echo "缺少 Android build-tools 工具：$BUILD_TOOLS/$tool" >&2
    echo "请先安装：sdkmanager \"platforms;android-34\" \"build-tools;34.0.0\"" >&2
    exit 1
  fi
done

if [ ! -f "$INPUT_HTML" ]; then
  echo "未找到 $INPUT_HTML，请先运行 npm run build:single" >&2
  exit 1
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/gen" "$BUILD_DIR/classes" "$BUILD_DIR/dex" "$BUILD_DIR/assets" "$OUT_DIR"

# 1. 拷贝单文件 HTML 作为 WebView 资源
cp "$INPUT_HTML" "$BUILD_DIR/assets/index.html"

# 2. 编译资源
"$BUILD_TOOLS/aapt2" compile --dir "$ANDROID_DIR/res" -o "$BUILD_DIR/res.zip"

# 3. 链接资源与清单，生成未签名 APK（含 assets）
"$BUILD_TOOLS/aapt2" link \
  -o "$BUILD_DIR/base.apk" \
  -I "$PLATFORM" \
  --manifest "$ANDROID_DIR/AndroidManifest.xml" \
  --java "$BUILD_DIR/gen" \
  -A "$BUILD_DIR/assets" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --version-code "$APK_VERSION_CODE" \
  --version-name "$APK_VERSION" \
  "$BUILD_DIR/res.zip"

# 4. 编译 Java 源码（android.jar 作为 classpath，lambda 交给 d8 脱糖）
JAVA_SOURCES=$(find "$BUILD_DIR/gen" "$ANDROID_DIR/src" -name '*.java')
javac -encoding UTF-8 -source 8 -target 8 -classpath "$PLATFORM" \
  -d "$BUILD_DIR/classes" \
  $JAVA_SOURCES

# 5. 转换为 dex
"$BUILD_TOOLS/d8" --lib "$PLATFORM" --min-api 24 --output "$BUILD_DIR/dex" \
  $(find "$BUILD_DIR/classes" -name '*.class')

# 6. 把 classes.dex 与原生库放入 APK
cp "$BUILD_DIR/base.apk" "$BUILD_DIR/unsigned.apk"
(cd "$BUILD_DIR/dex" && zip -q -u "$BUILD_DIR/unsigned.apk" classes.dex)
if [ -d "$ANDROID_DIR/jniLibs" ]; then
  (cd "$BUILD_DIR" && rm -rf lib && mkdir -p lib && \
    for abi in $(echo "$ABIS" | tr ',' ' '); do
      if [ -d "$ANDROID_DIR/jniLibs/$abi" ]; then
        mkdir -p "lib/$abi" && cp "$ANDROID_DIR/jniLibs/$abi"/*.so "lib/$abi/"
      fi
    done && \
    zip -q -r -u "$BUILD_DIR/unsigned.apk" lib)
fi

# 7. 对齐
"$BUILD_TOOLS/zipalign" -f -p 4 "$BUILD_DIR/unsigned.apk" "$BUILD_DIR/aligned.apk"

# 8. 生成签名密钥（首次）并签名
KEYSTORE="$ANDROID_DIR/keystore/wordvault.keystore"
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KEYSTORE_PASSWORD" -keypass "$KEYSTORE_PASSWORD" \
    -dname "CN=WordVault, OU=App, O=WordVault, L=Shanghai, ST=Shanghai, C=CN"
fi

"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KEYSTORE_PASSWORD" --key-pass "pass:$KEYSTORE_PASSWORD" \
  --out "$OUT_DIR/$APK_NAME" "$BUILD_DIR/aligned.apk"

"$BUILD_TOOLS/apksigner" verify --print-certs "$OUT_DIR/$APK_NAME"
echo "APK 已生成：$OUT_DIR/$APK_NAME ($(du -h "$OUT_DIR/$APK_NAME" | cut -f1))"
