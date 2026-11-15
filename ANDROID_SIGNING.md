# APK 固定签名（修复「无法自动更新，签名不相符」）

## 症状与原因

覆盖安装时 Android 要求**包名 + 签名证书**都与已装版本一致，否则拒绝：

```
INSTALL_FAILED_UPDATE_INCOMPATIBLE / signatures do not match
```

v1.0.0–v1.0.4 的 Release 都在 GitHub Actions 的**一次性 runner** 上打包，脚本会「首次生成 keystore」——每次 CI 都是全新环境，于是每个版本都换了一把新密钥。手机里装的是上一次随机签的，新包是这一次随机签的，自然对不上。

## 现在的做法

| 项 | 值 |
|---|---|
| 密钥 | 固定 RSA 2048 / PKCS12 keystore，有效期 10000 天 |
| 存放 | GitHub Actions Secrets（`WV_KEYSTORE_BASE64`、`WV_KEYSTORE_PASSWORD`） |
| 入库 | **不入库**，`.gitignore` 已有 `android/keystore` 与 `*.keystore` |
| 签名方案 | 显式开启 v1(JAR) + v2(APK) + v3，覆盖 Android 7.0+ |
| 公开指纹 | `8aa4cd2a121a56f98ca82722f72380e414e539ffd9f8d9cb76f31fd99831ada9` |

指纹不是敏感信息，直接写在 `release.yml` 里做断言。

### 三层防漂移

1. **前置校验**：`Verify signing secrets` 步骤检查两个 secret 都在，缺失直接 fail，绝不产出一个装不上的包
2. **CI 强制**：`build-apk.sh` 检测到 `CI` / `GITHUB_ACTIONS` 时，若 `WV_KEYSTORE_BASE64` 为空就退出；**不再自动生成密钥**
3. **打包后断言**：脚本用 `apksigner verify --print-certs` 读出实际 SHA-256，与 `WV_EXPECTED_CERT_SHA256` 比对，不一致就中止发布

指纹同时写进 `GITHUB_OUTPUT`、job summary 和日志，每次 Release 都能肉眼核对。

### 本地调试

本地没有 `CI` 环境变量、也没注入 secret 时，脚本退回生成一次性 debug keystore，并在 stderr 醒目提示「产出的 APK 不可用于发布/升级」。这个包只供开发看效果。

## 用户需要做什么

**只做一次**：如果手机上装的是 v1.0.4 或更早版本，装 v1.0.5 时仍需先卸载旧版（旧证书的签名找不回来了），先在 `我的 → 本地数据 → 导出备份` 或「附近设备传输」把学习记录转出去，装完再导回来。

从 **v1.0.5 → 之后所有版本**，签名恒定，直接覆盖安装，数据保留。

## 维护者：密钥轮换 / 迁移

- Secrets 丢了就完了：旧用户再也无法覆盖升级，只能卸载重装。**务必备份 keystore 与密码到离线密码库**（不要放进仓库、不要贴进对话）。
- 真要换证书，Android 9+ 支持 **APK Signature Scheme v3 的签名证书 lineage**，可用 `apksigner rotate` 生成 lineage 文件实现平滑换签；v3 已显式开启，路径留好了。
- 换证书后记得同步更新 `release.yml` 里的 `WV_EXPECTED_CERT_SHA256`，否则断言会主动拦下新包。

## 改动清单

- `android/build-apk.sh`
  - 区分 release / debug 签名模式，CI 缺密钥 fail fast
  - 显式 `--v1/v2/v3-signing-enabled true`
  - 提取并断言证书 SHA-256，写 `GITHUB_OUTPUT` / `GITHUB_STEP_SUMMARY`
- `.github/workflows/release.yml`
  - 新增 `Verify signing secrets`
  - 传入公开指纹常量、`Record certificate fingerprint` 步骤

## 验证

- `bash -n android/build-apk.sh` 通过
- 签名段 mock 演练：指纹匹配 → 退出 0 并写出 summary；指纹漂移 → 退出 1 并中止
- fail fast 演练：`CI=true` 且无 secret → 退出 1，不生成 APK
- v1.0.5 真实 CI：[run 43774018913](https://github.com/4uYS/WordVault/actions/runs/43774018913) 四个 job 全绿；`Verify signing secrets`、`Build APK`（内含指纹断言）、`Record certificate fingerprint` 三个步骤均 success
- 沙盒网络策略拦截了 release CDN 下载（HTTP 403），未能把 APK 拉回本地二次验签；但断言写在打包脚本内，指纹不符会直接让 `apk` job 失败，因此 job 成功即代表证书匹配
