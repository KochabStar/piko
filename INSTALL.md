# 新电脑安装 Piko

Piko 是 Windows x64 单文件程序，**不需要先安装 Git、Node 或 Bun，也不需要管理员权限**。根目录的 `install.ps1` 是在线／本地 ZIP 引导入口；发行 ZIP 内的 `install.ps1` 是原有离线 EXE 安装器，两者用途不同。

> 在线安装需要至少一个已发布、标为 Latest 的稳定版 Release。只有 tag、Actions artifact、草稿或预发布版不够；尚未发布时会明确报错，不会改用未经校验的构建。
>
> **公开访问前提：** 当前在线脚本不携带 GitHub 认证。若 `KochabStar/piko` 为私有仓库，即使已发布 Release，匿名新机也无法在线安装；默认软件源 `KochabStar/piko-source` 也需要可匿名访问。保留私有仓库时，请通过已认证的 GitHub CLI 下载资产，再使用下面的本地 ZIP 方式；私有源需另行配置，或先使用 `-NoSource`。不要为了安装而把访问令牌写进 URL 或脚本。

## 在线安装最新稳定版

在普通 PowerShell 5.1 或 PowerShell 7 中下载并审阅脚本，再运行：

```powershell
Invoke-WebRequest https://github.com/KochabStar/piko/releases/latest/download/install.ps1 -UseBasicParsing -OutFile install-piko.ps1
# 审阅 install-piko.ps1 后执行；默认 -Version latest。
.\install-piko.ps1
# 自定义安装盘：
.\install-piko.ps1 -PikoHome D:\piko
```

根目录 `install.ps1` 默认 `-Version latest`，无需每次修改版本号：它查询 GitHub 的 `/releases/latest`，选择最新稳定 Release，下载 `piko-<版本>-windows-x64.zip` 及其 `.zip.sha256`，校验整个 ZIP，再核对包内 `release.json`、`SHA256SUMS.txt` 与 EXE 摘要。仅提取、执行确切的 `piko.exe`，**不运行 ZIP 内脚本**。下载有超时、重定向和体积限制，拒绝 HTTPS 降级。预发布版不参与默认安装，需要显式指定 `-Version`。

上面的下载地址使用 Release 附件中的根目录在线脚本，与发行 ZIP 内的离线脚本不同。若当前会话的执行策略阻止脚本，可审阅后使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-piko.ps1`，这只影响该子进程，不永久更改执行策略；完成后重开终端。

同一发布渠道提供的摘要可发现损坏，但不能抵御发布账号或渠道整体被攻陷。发行物未签名；需要更强信任时，从独立可信渠道核对 ZIP 摘要并传入 `-Sha256`，脚本自身也应通过可信渠道取得或核对。

```powershell
.\install-piko.ps1 -Version 0.4.0 -Sha256 <独立核对的ZIP摘要>
.\install-piko.ps1 -Proxy http://127.0.0.1:7890
# 不改用户 PATH／不配置默认源：
.\install-piko.ps1 -NoPath -NoSource
```

脚本默认：

- 安装到 `-PikoHome`，否则使用当前 `PIKO_HOME`，最后回退 `%LOCALAPPDATA%\piko`。
- 将 `shims` 加入**用户 PATH**，更新本 PowerShell 会话的 PATH 和 `PIKO_HOME`；其他已打开终端需重开。使用 `powershell -File` 启动时，调用方父终端环境不能被子进程更新。
- 配置 `main` HTTPS 清单源 `https://raw.githubusercontent.com/KochabStar/piko-source/main/`，不依赖 Git。
- 不自动安装任何软件，不编辑 Shell Profile，不启用字体、关联、服务或驱动，不删除 Scoop／mise。
- 已有同摘要 Piko 时保持安装和软件状态；不同构建拒绝覆盖，升级用 `piko self update`。已有同名源配置不一致时拒绝替换。失败时可能保留已完成的 Piko 安装或源配置，不承诺跨注册表／文件系统事务，也不删除已有数据。

## 发布前／离线安装

准备由可信机器构建的完整发行 ZIP 和独立核对的 **ZIP SHA-256**：

```powershell
.\install-piko.ps1 -ArchivePath .\piko-0.4.0-windows-x64.zip `
    -Sha256 <ZIP_SHA256> -PikoHome D:\piko
# 完全离线（不配置远端源）：
.\install-piko.ps1 -ArchivePath .\piko-0.4.0-windows-x64.zip `
    -Sha256 <ZIP_SHA256> -PikoHome D:\piko -NoSource
# 明确指定其他 HTTPS 镜像，必须显式提供 ZIP 摘要：
.\install-piko.ps1 -ArchiveUrl https://example.com/piko.zip -Sha256 <ZIP_SHA256>
```

若已解压发行 ZIP，仍可使用其中原有的离线脚本；此处摘要是 **EXE 摘要**，与上面 ZIP 摘要不同：

```powershell
.\install.ps1 -Sha256 <EXE_SHA256> -PikoHome D:\piko -Path
```

自定义源支持 `-SourceName`、`-SourceUrl`、`-SourceType http|git`、`-SourceRef`；只有主动选用 Git 源时才需要已有 Git。`-Proxy` 作用于引导脚本的 Release 下载；Piko 获取软件源和包时遵循自身代理配置／环境。

## 安装软件

```powershell
piko source list
piko search node
piko install main/node
piko use main/node
node --version

piko install main/listary
piko use main/listary
piko doctor
```

软件功能取决于所安装的 Piko 发行构建；新机安装脚本不把工作区尚未发布的功能当作已发布能力。GUI 开始菜单、数据持久化及外部集成的具体支持以该版本说明为准。

## 维护者发布 Release

### 推荐：推送版本 tag 后自动发布

`.github/workflows/verify.yml` 在普通 push／PR 时只校验并上传 Actions artifact；只有推送 `v<版本>` tag 才会在校验成功后创建 GitHub Release。当前源码版本为 `0.4.0`，首次发布可以使用 `v0.4.0`；后续先同时修改 `package.json` 和 `src/version.ts`，再使用新的 tag，不覆盖已发布版本。

先提交要发布的代码和工作流，确认工作区干净，再执行：

```powershell
git status --short             # 应无输出；不要发布尚未提交的修改
git push origin master
git tag -a v0.4.0 -m "Piko 0.4.0"
git push origin v0.4.0
# 查看校验／发布结果：
gh run list --repo KochabStar/piko --workflow verify.yml --limit 5
gh release view v0.4.0 --repo KochabStar/piko
```

工作流会校验 tag 与两处版本声明一致，在 Windows 上重新构建并运行测试、格式／沙盒打包检查、发行包解包与隔离安装校验；全部成功后才使用受限的 `GITHUB_TOKEN` 发布以下三个附件，无需另配个人令牌：

```text
piko-<版本>-windows-x64.zip
piko-<版本>-windows-x64.zip.sha256
install.ps1                       # 仓库根目录的在线安装脚本
```

稳定版标为 **Latest**；带 `-beta.1` 等后缀的版本标为 **Pre-release**，不替代 Latest。任一检查失败不发布；版本不一致时修复版本声明并使用正确 tag。已存在的 Release 不自动覆盖，普通分支推送和手动运行校验也不会发布。

### 手动发布（备用）

从干净且版本声明一致的代码构建，确保该版本 tag 已推送并指向构建所用提交：

```powershell
.\.tools\bun.exe run verify
.\.tools\bun.exe run format:check
.\.tools\bun.exe run sandbox:check
.\.tools\bun.exe run release
.\.tools\bun.exe run release:check
gh release create v0.4.0 `
    .\dist\piko-0.4.0-windows-x64.zip `
    .\dist\piko-0.4.0-windows-x64.zip.sha256 `
    .\install.ps1 --repo KochabStar/piko --verify-tag `
    --title "Piko v0.4.0" --generate-notes --latest
```

仅在自动发布未创建 Release 时使用备用步骤，不要与自动发布同时执行。打包本身不会上传；已有同版本发行目录时会拒绝覆盖，不要误上传旧构建，应保留旧目录并选择新版本，或在干净工作区构建。预发布时将 `--latest` 换成 `--prerelease --latest=false`。

ZIP 必须保留生成的顶层目录与 `piko.exe`、`release.json`、`SHA256SUMS.txt`。ZIP 内的离线 `install.ps1` 不能替代 Release 根附件中的在线脚本。不要把本机迁移记录、缓存或私密配置打入发行物；CI 只打包已提交代码。

### 私有仓库：认证下载后安装最新稳定版

如果保留私有仓库，在已有权限的机器上执行：

```powershell
gh auth login
# 不传 tag：下载该仓库最新稳定 Release 的附件。
gh release download --repo KochabStar/piko --dir .\piko-release `
    --pattern 'piko-*-windows-x64.zip' `
    --pattern 'piko-*-windows-x64.zip.sha256' --pattern install.ps1
Set-Location .\piko-release
$archive = Get-Item .\piko-*-windows-x64.zip
$sha256 = ((Get-Content ($archive.FullName + '.sha256') -Raw).Trim() -split '\s+')[0]
# 源若也为私有，不尝试匿名配置：
.\install.ps1 -ArchivePath $archive.FullName -Sha256 $sha256 -NoSource
```

使用新的空下载目录，避免把多个版本混在一起；`gh` 的登录不会让在线安装脚本自动获得认证。本地方式仍校验 ZIP 和 EXE，不自动升级另一份已有构建。摘要与下载来自同一发布渠道，若需抵御渠道被攻陷，仍应另行核对可信摘要。
