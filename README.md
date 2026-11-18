# Piko

Windows x64 命令行包管理器：管理桌面软件、开发工具、运行时和 npm CLI，支持多版本安装与切换。Piko 是单文件 EXE，不需要预装 Git、Node 或 Bun。

## 安装

在普通 **PowerShell 5.1 或 PowerShell 7** 中执行：

```powershell
irm https://github.com/KochabStar/piko/releases/latest/download/install.ps1 | iex
```

安装最新稳定版，默认目录为 `%LOCALAPPDATA%\piko`（已设置 `PIKO_HOME` 时沿用该目录），自动加入用户 PATH 并配置默认软件源 `main`。无需管理员权限，不修改系统 PATH 或永久执行策略。

此命令会执行官方发布的安装脚本；脚本校验下载的 ZIP 和 EXE 摘要，发行物目前未签名。需要先审阅脚本、自定义目录、代理或离线安装时，见 [安装指南](INSTALL.md)。其他已打开的终端或 IDE 需重开。

## 开始使用

```powershell
piko --version
piko search node --refresh
piko install main/node
piko use main/node
node --version
```

`install` 安装但不选择命令行默认版本；`use` 选择已安装版本。GUI 软件安装后自动创建开始菜单快捷方式。也可用 `piko use main/node@latest` 一步安装并选择最新版。

## 常用命令

```powershell
piko list                         # 已安装软件
piko info main/node               # 软件信息
piko use main/node@26              # 选择主版本，后续更新仍跟随此范围
piko outdated                     # 检查软件更新
piko update main/node             # 更新指定软件，保留旧版
piko update --all                 # 更新全部已选软件
piko update --yes                 # 升级 Piko 自身
piko uninstall main/node          # 卸载唯一版本或当前默认版本，保留持久化数据
piko cleanup * --dry-run          # 预览旧版本清理
piko reset main/node              # 修复已安装软件的命令入口和数据映射，不重新下载
piko doctor                       # 诊断环境和命令冲突
piko help                         # 完整命令列表
piko help install                 # 某条命令的参数和示例
```

支持精确版本、主／次版本、`latest` 和源声明的渠道。npm CLI 使用 `npm:<包名>`，安装前需先安装并选择受管理的 Node/npm，例如 `piko use npm:prettier@latest`。

## 使用边界

- 默认软件源是 [piko-source](https://github.com/KochabStar/piko-source)，不兼容 Scoop bucket，不接管已有的外部安装。
- 普通安装只下载、校验和解包。Shell 初始化、管理员集成和服务须单独预览授权，不自动提权；向日葵等软件的额外步骤见软件源中的使用指南。
- 多版本共享的持久化数据不随普通卸载删除；更新和回退前请备份重要资料。

## 开发

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run verify
```

使用 Bun 1.4.4，构建输出 `dist/piko.exe`。自定义／离线安装与 Release 发布步骤见 [INSTALL.md](INSTALL.md)。
