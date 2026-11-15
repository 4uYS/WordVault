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
# 发布签名的公开证书指纹（去冒号小写）。CI 每次打包都会断言，防止签名漂移。
EXPECTED_CERT_SHA256="${WV_EXPECTED_CERT_SHA256:-}"

# ── 签名密钥来源 ───────────────────────────────────────────────────────────
# CI：必须由 Secrets 注入同一份 keystore。绝不允许自动生成，否则每个 Release
#     签名都不同，用户覆盖安装会报「签名不相符」。缺失时直接 fail fast。
# 本地：允许生成一次性 debug keystore，但醒目提示不能用于发布。
if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
  if [ -z "${WV_KEYSTORE_BASE64:-}" ]; then
    echo "❌ CI 打包缺少 WV_KEYSTORE_BASE64 secret。" >&2
    echo "   请在仓库 Settings → Secrets → Actions 配置固定签名密钥，" >&2
    echo "   否则会生成随机签名，导致用户无法覆盖安装。" >&2
    exit 1
  fi
  if [ -z "${EXPECTED_CERT_SHA256}" ]; then
    echo "❌ CI 打包缺少 WV_EXPECTED_CERT_SHA256，无法校验签名一致性。" >&2
    exit 1
  fi
  SIGNING_MODE="release"
else
  SIGNING_MODE="debug"
fi

KEYSTORE="$ANDROID_DIR/keystore/wordvault.keystore"
if [ -n "${WV_KEYSTORE_BASE64:-}" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  printf '%s' "$WV_KEYSTORE_BASE64" | base64 -d > "$KEYSTORE"
elif [ "$SIGNING_MODE" = "debug" ]; then
  echo "⚠️  本地调试模式：将生成一次性 debug 密钥，产出的 APK 不可用于发布/升级。" >&2
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

# 8. 签名
#    本地调试且未注入密钥时才生成一次性 debug keystore。
if [ ! -f "$KEYSTORE" ]; then
  if [ "$SIGNING_MODE" = "release" ]; then
    echo "❌ 固定 keystore 未落地，拒绝签名。" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KEYSTORE_PASSWORD" -keypass "$KEYSTORE_PASSWORD" \
    -dname "CN=WordVault-Debug, OU=App, O=WordVault, L=Shanghai, ST=Shanghai, C=CN"
fi

# 显式开启 v1(JAR) + v2(APK) + v3(密钥轮换友好)，覆盖 Android 7.0 以上全部机型
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KEYSTORE_PASSWORD" --key-pass "pass:$KEYSTORE_PASSWORD" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$OUT_DIR/$APK_NAME" "$BUILD_DIR/aligned.apk"

# 校验签名有效，并提取实际证书指纹
CERT_INFO="$("$BUILD_TOOLS/apksigner" verify --print-certs "$OUT_DIR/$APK_NAME")"
ACTUAL_SHA256="$(printf '%s\n' "$CERT_INFO" \
  | grep -i -m1 'SHA-256 digest' \
  | sed -E 's/.*SHA-256 digest:[[:space:]]*//I' \
  | tr -d ' :' | tr 'A-F' 'a-f' || true)"

if [ -z "$ACTUAL_SHA256" ]; then
  echo "❌ apksigner 未能读出证书指纹，签名校验失败。" >&2
  exit 1
fi

echo "签名证书 SHA-256: $ACTUAL_SHA256"
echo "签名方案: $(printf '%s\n' "$CERT_INFO" | grep -i -m1 'Verified using' || true)"

if [ -n "$EXPECTED_CERT_SHA256" ]; then
  EXPECT="$(printf '%s' "$EXPECTED_CERT_SHA256" | tr -d ' :' | tr 'A-F' 'a-f')"
  if [ "$ACTUAL_SHA256" != "$EXPECT" ]; then
    echo "❌ 签名漂移！期望 $EXPECT，实际 $ACTUAL_SHA256" >&2
    echo "   这个包会让用户覆盖安装时提示「签名不相符」，已中止发布。" >&2
    exit 1
  fi
  echo "✅ 签名与固定 release 证书一致（v1.0.5 起可平滑覆盖升级）"
fi

# 把指纹写进 GitHub Actions 输出与 job summary，便于每次 Release 肉眼核对
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'cert_sha256=%s\n' "$ACTUAL_SHA256" >> "$GITHUB_OUTPUT"
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '### APK 签名\n\n- SHA-256: `%s`\n- 签名模式: `%s`\n- 指纹断言: %s\n' \
    "$ACTUAL_SHA256" "$SIGNING_MODE" \
    "${EXPECTED_CERT_SHA256:+已通过}" >> "$GITHUB_STEP_SUMMARY"
fi

echo "APK 已生成：$OUT_DIR/$APK_NAME ($(du -h "$OUT_DIR/$APK_NAME" | cut -f1))"
