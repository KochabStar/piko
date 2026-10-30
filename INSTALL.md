# 新电脑安装 Piko

Piko 是 Windows x64 单文件程序，**不需要先安装 Git、Node 或 Bun，也不需要管理员权限**。根目录的 `install.ps1` 是在线／本地 ZIP 引导入口；发行 ZIP 内的 `install.ps1` 是原有离线 EXE 安装器，两者用途不同。

> 当前仓库尚未发布 GitHub Release（创建本文时核实）。在线命令在发布含下列资产的 Release 后才可用，未发布时会明确报错，不会改用未经校验的构建。现在可使用下面的本地发行包方式。

## 在线安装（发布 Release 后）

在普通 PowerShell 5.1 或 PowerShell 7 中下载并审阅脚本，再运行：

```powershell
Invoke-RestMethod https://raw.githubusercontent.com/KochabStar/piko/master/install.ps1 -OutFile install-piko.ps1
# 审阅 install-piko.ps1 后执行；不需要永久更改执行策略。
.\install-piko.ps1
# 自定义安装盘：
.\install-piko.ps1 -PikoHome D:\piko
```

默认选择最新稳定 Release，下载 `piko-<版本>-windows-x64.zip` 及其 `.zip.sha256`，校验整个 ZIP，再核对包内 `release.json`、`SHA256SUMS.txt` 与 EXE 摘要。仅提取、执行确切的 `piko.exe`，**不运行 ZIP 内脚本**。下载有超时、重定向和体积限制，拒绝 HTTPS 降级。

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

## 维护者发布要求

已有 `bun run release` 生成 ZIP 与 `.zip.sha256`，`bun run release:check` 验证解包与离线安装。测试和校验通过后，另行发布 tag `v<版本>` 的 GitHub Release，至少附带：

```text
piko-<版本>-windows-x64.zip
piko-<版本>-windows-x64.zip.sha256
```

ZIP 必须保留生成的顶层目录与 `piko.exe`、`release.json`、`SHA256SUMS.txt`。不要把本机迁移记录、缓存或私密配置打入发行物。此安装入口的提交不会自动发布 Release，也不会上传未提交的本地功能。
