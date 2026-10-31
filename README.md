# Piko

使用 **TypeScript + Bun** 开发的 Windows x64 命令行包管理器，当前为 **0.4.0 预览版**。统一管理便携程序、Node 等运行时和 npm CLI；Piko 的 EXE 不需要预装 Node/Bun。

替代目标与待办见 [替代 Scoop 与 mise 的功能差距](docs/replacement-gaps.md)（仅用户级软件与全局版本管理，不包含 mise 项目功能）。本轮依赖、集成升级、Shell、npm、安装载荷与 Rust 的新增能力、用法和边界见 [B 类限制完善记录](docs/b-improvements.md)。

## 已实现

- 单文件、ZIP、7z、tar、tar.gz、tar.xz 分发，以及 Inno Setup 安装包的只解包安装；多文件组合下载与初始文本配置，逐项 SHA-256 校验与可信缓存。HTTPS 静态清单源、Git 清单源和 npm registry。
- 所有软件多版本共存；安装不选默认。`use` 选择已安装版本，`current` 为 junction，EXE shims 供 CMD、PowerShell 和普通子进程调用。
- 按精确版本、主/次版本或源声明的渠道别名更新，保留旧版本；支持逐包批量更新、远端候选预览与运行时发行版选择。
- 非默认版本清理预览与保留策略；可移植整机软件清单导出、恢复计划和显式确认，保留来源、默认请求和命令别名。
- 显式命令归属、释放、可执行别名和 PATH 遮蔽诊断，不接管外部安装。
- manifest env、声明式持久化目录、数据预览和确认清理。
- 普通软件清单可声明依赖；默认安装不自动切换依赖。另有绑定确认的传递依赖安装、活跃消费者保护和启动时检查。
- 安装晋升、默认切换、卸载、数据清理、npm 重建与自升级的日志恢复。
- npm CLI 按包/版本隔离，运行时使用当前默认受管理 Node；安装和更新始终禁用生命周期。内容绑定批准后显式重建，依赖逐项批准。
- 受校验的 Piko 自升级、备份和兼容性回退；本地 ZIP 发行包、安装入口和 CI 配置。

桌面软件扩充后的源码及 EXE 已通过本机 **165 项测试、1,660 次断言、0 失败**。独立源共 46 包；本轮新增 8 款均通过隔离安装、默认选择／命令入口、主程序版本和 Windows 签名检查，另验证两款远控软件的配置留存模型。当前构建与清单摘要见 `docs/verification/desktop-apps-20261029.json`；之前的 19→38 包扩充和 B 类完善分别保留在 `source-expansion-20261029.json`、`b-improvements.json`。类型、构建、格式及示例／46 包源校验通过。本轮未启动 GUI、服务／驱动或新 Sandbox，没有接管现有安装或改动日常 PATH／Profile。实际编译 CLI 覆盖 PowerShell 5.1／7 与 Git Bash；未修改日常 PATH／Profile。历史 0.3.0 有 62 条实际 Sandbox 检查通过，0.4.0 的两份旧构建分别通过 75 条基础和 51 条集成专项；它们不等于本轮构建的完整 Sandbox 验收。本轮未启动 Sandbox，管理员实装、真实 Rust 工具链、PowerShell 7 沙盒与 Windows 10 清洁环境仍需验收。

## 开发与构建

固定 Bun **1.4.4**；测试需要开发机 Node/npm，当前受测 Node 26.12.1 / npm 11.20.0。辅助工具回归首次会下载已固定摘要的官方 7-Zip／aria2、Inno 解包器和测试用 Inno 编译器发行文件，缓存在 `.tools/helper-fixtures/`，之后可复用；编译器只用于生成测试安装包，不执行其安装程序。测试使用项目依赖和独立临时安装，不修改宿主用户 PATH。

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run verify                 # 类型检查、EXE 构建、回归
bun run format:check
bun run sandbox:check          # 脚本和文件锁测试，不启动沙盒
bun run source:check
bun run benchmark
```

只有 Node/npm 时，在仓库中引导本地 Bun：

```powershell
npm install --ignore-scripts --package-lock=false
node scripts/bootstrap-bun.cjs
.\.tools\bun.exe run verify
```

构建输出为 `dist/piko.exe`。开发脚本可用本地 Bun 替换 `bun`。

## 安装

```powershell
.\dist\piko.exe setup          # 默认 %LOCALAPPDATA%\piko，不改 PATH
.\dist\piko.exe setup --path   # 显式加入用户 PATH，不改系统 PATH
```

完成后重开终端或 IDE。EXE 不能修改已有父终端环境。也可设置 `$env:PIKO_HOME = 'D:\piko-test'` 使用独立根目录。重复 setup 不会覆盖现有另一份 Piko 或删除状态，升级使用单独命令。

发行包生成与检查：

```powershell
bun run release                 # 生成 dist/piko-0.4.0-windows-x64.zip
bun run release:check            # 解包、核对摘要、实际安装到临时根目录
# 解压发行包后，使用独立可信渠道核对的 EXE 摘要：
.\install.ps1 -Sha256 <EXE_SHA256> -PikoHome D:\piko -Path
```

发行物当前未签名；ZIP、EXE 各有摘要。打包不会上传，CI 配置不会自行发布；已有同版本发行目录时拒绝覆盖。

## 可读软件目录

新安装使用 `apps/node/26.12.1`、`apps/git/2.56.0.4` 和 `persist/uv`，`current` 指向默认版本；来源标识仍保存在状态与安装收据中，不用哈希装饰用户目录。同名跨源／冲突的 npm 名称拒绝覆盖，必须先明确处理旧安装和数据。安全的四段厂商版本原样保留，不安全版本标识仍编码。

旧目录继续兼容读取，不会在日常更新中静默移动。已安装目录可用独立预览和绑定迁移：

```powershell
piko maintenance layout --dry-run
piko maintenance layout --yes --binding <预览摘要>
piko maintenance layout --recover    # 仅在迁移中断时完成已记录的操作
```

迁移备份状态和收据，保留包 ID、来源、版本、命令归属和用户数据，重建 current／持久化 junction。迁移期间阻止程序启动；遇到冲突、未知链接、已批准外部集成、npm 旧安装或路径绑定模板时拒绝并要求单独处理。新布局使用 **state schema 8**，旧 EXE 无法读取；不要强行换回旧构建。

## 安装软件

独立的 `../piko-source/` 当前有 **46 个包**：原 38 包覆盖已盘点的 Scoop／mise 目标，另登记用户选择的 8 款桌面软件。维护说明与验证见其 README、`verification/desktop-apps-20261029.json`；原扩充记录保留在 `verification/coverage-20261029.json`。微信与向日葵清单采用可核验的官方新版，本机原安装未升级。独立源不自动复制到客户端示例源。

客户端示例内附固定版本 Node **26.12.1**、ripgrep **15.2.0**，不是自动追踪上游最新版本。`examples/source/` 或发行包中的 `source/` 可以作为 HTTPS 静态目录托管，不需要用户本地持续运行服务器。开发试用可在仓库运行 `bun run source:serve`，然后：

```powershell
piko source add main http://127.0.0.1:8765/
piko info main/node
piko install main/node@26.12.1
piko use main/node@26
node --version

piko install main/ripgrep@15.2.0
piko use main/ripgrep@15
rg --version

piko install npm:prettier@3.9.10
piko use npm:prettier@3
prettier --version

piko install npm:@mariozechner/pi-coding-agent@0.73.1
piko use npm:@mariozechner/pi-coding-agent@0.73.1
pi --version
```

只有回环 HTTP 允许作测试源。HTTPS 不降级，Git 使用已有 Git 和认证，不修改用户 Git 配置。

```powershell
piko source add tools https://example.com/owner/piko-source.git --type git --ref main
piko source refresh tools
piko source list
piko source remove tools          # 有安装引用时拒绝
piko source remove tools --force  # 只移除配置，软件与来源记录保留
```

源是 Piko 清单格式，不兼容 Scoop bucket。Git 从固定 commit 读取，不 checkout 或运行仓库代码。源刷新失败直接报错，不使用过期缓存；移除源后更新需要恢复同一来源。

## 分发格式与声明式安装

平台分发项的 `format` 支持 `file`、`zip`、`7z`、`tar`、`tar.gz`、`tar.xz`、`inno`、`msi` 和 `nsis`。后三者均只解包；`nsis` 必须明确选择内层归档，不执行安装器。单文件／单归档继续沿用现有 `url`、`sha256`、`format` 写法；`.tgz` 可声明为 `tar.gz`。

ZIP 不依赖外部解压程序。**7z、tar、tar.gz、tar.xz 统一使用真正的 7-Zip**：优先复用 Piko 已安装且校验通过、提供 `7z` 原生命令的 `7zip` 包；有默认版本优先使用默认，否则使用同一来源中已安装的最高数字排序版本。多个来源均可提供时拒绝歧义，不从 PATH 随意调用外部 7z。

没有受管理的 7-Zip 时，首次安装上述非 ZIP 归档分发会自动准备固定版本 **7-Zip 26.05 x64 控制台辅助程序**，放入 `apps/piko/helpers/7zip/26.05/7za.exe`，不注册全局命令、不切换默认、不安装 GUI 或执行 MSI。通过固定官方发布地址及摘要下载 `7zr.exe` 和 extra 归档，再校验解出的 `7za.exe`；引导程序只是暂存使用。之后复用私有副本并检查摘要，`--skip-checksum` 不能绕过辅助程序校验。辅助工具不属于 `piko list` 中的普通软件包；目标安装失败时，已准备好的工具可保留供下次复用。

7-Zip 先列出条目，经路径、类型、加密、大小和冲突检查后，按归档顺序以有界批次输出到标准输出，由 Piko 按已验证长度逐文件写入暂存目录，不允许外部解包器自行选择输出路径。每批最多 128 个文件，并限制命令参数长度，避免 PortableGit 等大型 solid 归档每个文件都重新解压同一数据块；超长／短缺／额外输出和辅助进程错误仍拒绝。

`tar.gz`、`tar.xz` 先由 7-Zip 将外层 gzip／xz 解为暂存目录中固定名称的 TAR 文件，再检查并解出 TAR 内条目；不会采用外层归档指定的文件路径。**不再依赖 Windows 自带的 tar.exe**。外层解码输出限制 2 GiB，各子进程限制 120 秒。

需要多个下载文件时改用 `downloads`（1–32 项），不要同时声明顶层下载字段。以下是 `platforms.windows-x64` 的结构示例，地址和摘要需替换为已核验的真实值：

```json
{
  "downloads": [
    {
      "url": "https://downloads.example.com/tool.7z",
      "sha256": "<程序归档的 SHA-256>",
      "format": "7z",
      "stripPrefix": "tool-1.0",
      "into": "bin"
    },
    {
      "url": "https://downloads.example.com/helper.dll",
      "sha256": "<DLL 的 SHA-256>",
      "format": "file",
      "file": "helper.dll",
      "into": "bin"
    }
  ],
  "bin": { "tool": "bin/tool.exe" },
  "configFiles": { "data/settings.ini": "[General]\nPortable=true\n" },
  "persist": ["data"]
}
```

- 每项独立校验、独立缓存；只有全部下载、解包和配置步骤成功后才登记安装，不选默认。多下载的收据 `checksum` 是按下载顺序排列的实际 SHA-256 数组的 JSON 摘要；单下载保持原始摘要语义。
- `stripPrefix` 去掉归档内的固定顶层目录，所有条目必须位于该目录内；`into` 指定安装目录中的目标子目录。`file` 仅用于单文件下载，`bin` 始终相对最终安装根目录。
- 多个归档可合并同名同大小写的目录，但文件重名、大小写别名、目录／文件冲突一律拒绝，不按下载顺序覆盖。整个安装共享 10 万条目、最终应用单文件 512 MiB、默认展开内容共 2 GiB；平台项 `maxExpandedBytes` 可显式设置总展开预算，硬上限 8 GiB。显式嵌套归档的中间层文件可达 2 GiB，但仍计入共享总预算并经 stdout 流式处理；不会提高最终应用文件的上限。下载默认 512 MiB，每项 `maxBytes` 可显式设置，硬上限 2 GiB，缓存命中也检查。gzip／xz 外层解码和 MSI 中间 CAB 合计另限 2 GiB，各辅助进程限 120 秒。提高限额会增加内存／磁盘需求，不是无限解包。
- `configFiles` 仅创建初始 UTF-8 文本：最多 128 项、每项 64 KiB、合计 1 MiB。禁止覆盖已解包文件或安装收据，不作模板求值，也不执行内容；位于已声明持久化目录的初始配置不会覆盖现有用户数据。
- `--skip-checksum` 仅授权本次指定包版本的所有下载，不会绕过路径、类型、冲突或大小检查，也不写入可信缓存；任一下载未匹配声明摘要，整个安装记为未验证。

仍不支持加密归档、链接／特殊文件、任意安装器自动识别。常规 install/update 不执行安装脚本；另行授权的 bootstrap／system 是明确的安装代码执行例外。注册表／文件关联仅通过下文独立用户集成或管理员配方处理，不能从普通解包隐式触发。PowerShell Profile 仅在单独预览、内容绑定授权后写入受管理加载块，见下文；不直接改变已运行父 Shell。普通 `file` EXE 下载不会被执行。

### Inno Setup：只解包，不执行安装程序

针对解包后能便携运行的软件，在 `platforms.windows-x64` 中使用以下结构（地址和摘要需换成真实值）：

```json
{
  "url": "https://downloads.example.com/tool-setup.exe",
  "sha256": "<安装包的 SHA-256>",
  "format": "inno",
  "bin": { "tool": "tool.exe" },
  "persist": ["data"]
}
```

- 默认取安装包的 `{app}` 目录。`stripPrefix: "subdir"` 与 `"{app}/subdir"` 都只选 `{app}` 下的该子目录；`into` 仍指定最终安装根目录内的目标子目录。不同于普通归档，Inno 中不属于选定子树的条目会被忽略，不落盘；`{sys}`、`{tmp}` 等目标不支持选择。
- 优先复用 Piko 已安装且校验过的 `innounp` 包；缺失时自动下载固定提交、ZIP 摘要和 EXE 摘要的 Unicode **innounp 2.71.2** 到 `apps/piko/helpers/innounp/2.71.2/`。不依赖 7-Zip、不创建公开命令或切换默认，`--skip-checksum` 不绕过辅助工具校验。
- 先以 UTF-8 列出完整文件清单并检查路径、大小、重名和文件／目录冲突，再将每个选定文件扁平解入独立暂存目录；检查输出名称、数量、类型和实际大小后，由 Piko 写入最终暂存布局。安装器本体绝不作为子进程执行。
- 不执行 `[Code]`、`[Run]`、注册表、服务、文件关联、快捷方式或卸载脚本；不模拟组件／任务／体系结构条件。条件变体默认拒绝；可用 `files` 确切映射选定副本，例如 `{ "BCompare,2.exe": "BCompare.exe" }`。映射相对选定 app 子树，未列出的文件不提取，缺少任一映射源则失败，不自动猜架构或全局替换文件名。
- 不能解析的新版格式、损坏／需密码／缺少外部分卷的安装包明确失败，不回退执行安装程序。辅助工具能力仍有限，不能据此声称支持所有 Inno Setup 版本；当前实际测试包含 Inno Setup 7.1.0 生成的安装包。

**解包成功不等于软件能便携运行。** 必须运行安装脚本、注册服务、安装驱动或依赖系统集成的软件仍不适合这种安装方式；应由源维护者验证实际工作流。卸载沿用普通便携包的文件删除和持久化数据保留规则。

### MSI 与嵌套归档：只提取载荷

MSI 使用 `format: "msi"`，`stripPrefix` 相对 MSI 目标目录树（省略 `SourceDir` 根标识）。例如 7-Zip 为 `Files/7-Zip`、LLVM 为 `LLVM`。选定子树外文件只检查元数据、不安装；可用 `files` 进一步列出确切源路径与目标路径。

客户端自动准备固定摘要的 **lessmsi 2.12.9**（只执行 `l -t` 读取 Media／Directory／Component／File 表）和完整 **7-Zip 26.05**。后者从官方自解压包中提取，不执行该 EXE；与原精简 `7za.exe` 分开存放在 `apps/piko/helpers/full7zip/26.05/`。工具 EXE、配置、应用 DLL 均校验，出现未知文件或篡改拒绝复用，不从 PATH 借用工具，不创建公开命令。

Piko 验证目录图、长文件名、文件标识与 CAB 对应关系后，用 7-Zip 将内嵌 CAB 和文件输出到标准输出，Piko 自己限量落盘。CAB 文件按已验证条目顺序分批输出，逐段检查长度并独占创建文件；不允许外部解包器自行选择输出路径。**不调用 lessmsi 的 `x`、`msiexec /a` 或 MSI CustomAction**。支持 1–32 个 CAB；外部 CAB 必须通过 `cabinets` 逐项声明 URL／SHA-256，独立校验后提取，Media 表必须准确引用。未压缩散文件、分卷和歧义布局仍明确失败，不回退执行安装器。

嵌套解包在外层下载项使用 `nested`，最多三层。外层可为 `zip`／`7z`／`nsis`／`pe`，每层只允许声明的 `zip`／`7z`，文件路径相对前一层已展开布局；每层 `stripPrefix` 用于该内层归档，外层 `into` 仅作用于最终载荷。不能同时给外层设置 `stripPrefix` 或 `files`。

```json
{
  "url": "https://downloads.example.com/app-setup.exe",
  "sha256": "<真实 SHA-256>",
  "format": "nsis",
  "nested": [{ "path": "$PLUGINSDIR/app-64.7z", "format": "7z" }],
  "bin": { "app": "App.exe" }
}
```

NSIS 必须明确声明 `nested` 内层归档，或以非空 `files` 精确映射原始文件路径到目标路径；不执行安装逻辑、不猜测条件分支。显式文件映射会先验证全部源文件与目标冲突，再通过有界 stdout 逐个写入；不能与外层 `stripPrefix` 或 `nested` 同用。NSIS 未报告尺寸时，以单文件及剩余总预算限制 stdout，按实际大小记账；已报告尺寸必须完全匹配，已知尺寸的其他选中项会先预留预算。

`pe` 只允许通过 `nested` 选择精确的资源／节路径，例如 `.rsrc/2052/SUN_SKIN/111`；资源必须有明确大小，其内容只能继续按声明的 ZIP／7z 解析。由固定、验证过的完整 7-Zip 列出并经 stdout 提取资源到固定暂存文件，不启动 EXE、不执行入口点，也不让解包器选择输出目录。

这些能力不代表任意 NSIS 或 EXE 都可便携运行。所有中间层计入共享展开预算并在 finally 清理，安装失败不发布部分版本；已准备的私有工具可保留。

已隔离验证真实 7-Zip MSI、Beyond Compare x64 变体、Obsidian／Tabby 内层归档，以及 LLVM 23.1.4。LLVM 下载约 611 MiB、展开约 2.98 GiB，因此清单显式设置 1 GiB 下载／4 GiB 展开预算。关键 EXE、DLL、库与头文件摘要和原同版安装一致，clang `--version` 通过；没有运行 GUI、迁移配置或注册 Shell 扩展。命令名新增允许 `clang++` 中的 `+`，包名和源名仍用原来的严格规则。

## aria2 下载

普通软件的分发文件、辅助工具引导文件和 Piko HTTPS 自升级下载，按以下顺序选择下载器：

1. Piko 已安装并校验通过的 `aria2` 包（使用其真实 `aria2c` 程序，不要求先 `use`；默认版本优先，来源歧义拒绝）。
2. 当前 PATH 中的 `aria2c.exe`，例如已由 Scoop 安装的版本；仅调用，不修改或接管它。不把当前 Piko 根目录的 shim 再当下载器递归调用。
3. 都没有时使用内置下载，不自动安装 aria2。

aria2 配置最多 5 路连接，禁用用户配置、netrc、RPC、torrent/metalink 自动处理。通过随机令牌保护的本地临时 HTTP 入口接收文件和 Range 请求，Piko 转发并校验远端 HTTPS／重定向，避免 aria2 自行跟随不安全重定向或把私密下载 URL 打入日志。校验与缓存规则不变；已命中可信缓存不启动下载器，下载失败明确报错，不静默切回内置下载；临时下载目录在正常结束或报错后清理。

软件源索引／清单等小型元数据仍用内置下载；npm registry 下载仍交给 npm。外部 aria2 以当前用户权限运行，不是沙盒。

## 普通软件依赖

在清单的 `platforms.windows-x64` 分发项中声明 `depends`，例如 z.lua 对 Lua 的要求可以表示为：

```json
{
  "depends": [
    { "package": "lua@5", "commands": ["lua"] }
  ]
}
```

此处仅说明依赖字段；独立 `../piko-source/` 已提供 Lua／z.lua 清单和另行授权的 PowerShell 初始化，见后文。

- `package` 是包身份，不是命令名。不带来源时绑定当前清单所在源；也可显式写 `tools/lua@5`，不会使用其他源中的同名包或外部 Scoop/PATH 安装充数。
- 支持精确版本、主/次版本简写及依赖来源声明的版本别名；依赖版本标识限字母、数字、`.`、`_`、`+`、`-`，不支持完整范围表达式。省略版本或使用 `latest` 表示接受用户当前显式选择的任意版本，**不要求它是源中最新版本**，也不触发上游检查。
- 依赖必须已安装并选择默认版本，只有其他已安装版本满足要求并不够。`commands` 可省略；若声明，命令或别名必须实际指向该依赖的默认版本，且目标文件存在，不得由其他包提供。
- `install`（包括重复安装）在下载目标软件前检查依赖，不满足就拒绝并给出手动安装、`use` 或命令归属指引。`update` 安装候选新版时复用检查；失败保留原默认版本。
- `piko info <source>/<package>@<version>` 在 `available[].version` 和 `dependencies` 中展示该候选版本的依赖与满足状态；省略版本时检查源的 `latest`。

默认安装仍不自动选择依赖。可用 `install <包> --with-deps --dry-run` 预览传递依赖图，再用 `--with-deps --yes --binding <摘要>` 顺序安装并选择缺失依赖；根包不选默认，已有默认不兼容时拒绝。新普通包收据保存依赖，选择、命令归属／别名变更、取消默认和强制卸载保护活跃消费者；启动时沿已安装依赖图复查。旧普通包收据不伪造依赖记录，需保留数据卸载重装后获得完整保护。普通依赖不能引用 npm，npm 包内依赖由 npm 处理；不隐式执行初始化或 bootstrap。范围、循环／冲突／规模限制与重试语义见 [完善记录](docs/b-improvements.md#1-普通依赖)。

## 版本与更新

```powershell
piko list                       # 紧凑表格，* 表示当前选择
piko list llvm                  # 按包名／来源／版本筛选
piko list --selected             # 只显示当前选择的版本
piko list --verbose              # 显示版本请求和完整安装路径
piko list --json                 # 脚本使用结构化输出
piko search llvm                 # 本地索引搜索，不联网、不持有写锁
piko search llvm --refresh       # 显式刷新软件源再搜索
piko search llvm --json
piko info main/node
piko which node
piko use main/node@26.12.1       # 精确版本固定
piko update main/node           # 沿用 use 保存的请求
piko outdated                  # 查询远端候选、请求约束和受阻原因
piko status main/node          # outdated 的别名，可筛选包
piko update --all --dry-run     # 查询候选，不安装、不切换默认
piko update --all               # 串行逐包处理，输出成功/失败明细
piko unuse main/node
piko uninstall main/node@26.12.1
```

`search` 默认只读取已验证的本地源索引（离线可用），不会刷新远端、修改状态或争用 mutation.lock。使用 `source refresh [alias]` 或 `search <query> --refresh` 更新索引；本地索引缺失／损坏时明确报错，不隐式联网。`search` 与 `list` 默认使用按包排序的表格；原 JSON 字段保留在 `--json` 输出中，脚本调用需显式添加该参数。搜索与列表均支持大小写不敏感的子串匹配。

### 命令行进度与输出

交互终端使用 Gemini CLI 风格的蓝紫／青色点阵动画与细线进度条：包名加粗，传输大小、速度和剩余时间用次要颜色显示，成功／失败使用独立符号。只更新当前一行，不加横幅、面板或未变化包日志。支持真彩色的终端使用 RGB 点缀，其他终端回退到 ANSI 配色；`--no-color`／`NO_COLOR` 保留无颜色文本，兼容模式使用 ASCII 符号。窗口变窄时按优先级隐藏 ETA、总大小和批次编号，优先保留包名与真实百分比，按显示宽度处理中文并避免自动换行。无总大小时仅展示实际接收量与速度。

```text
  ⠹  2/3  main/llvm  Download  ━━━━━━━╸──────────  42%  42.0 MiB / 100.0 MiB  10.0 MiB/s  · ETA 6s
```

此行为仅美化人类可读输出，JSON、管道／CI 日志和默认只展示实际更新包的规则保持不变。

交互终端中，安装和更新使用单行动态进度，显示当前包、解析源／清单、依赖检查、下载、SHA-256 校验、解压和提交阶段。内置下载器与 aria2 均报告已接收字节、平均速度；有可信总大小时显示百分比和估算剩余时间，无总大小时不猜测百分比。aria2 重试与重叠分段按唯一字节区间计数；下载结束仅代表传输完成，后续仍须校验与安装成功。命中缓存时显示缓存校验，不伪装为重新下载。npm 子进程显示安装／完整性核验阶段，不编造字节进度。

默认使用精简输出：`update --all` 只在一行动态显示当前包／阶段，真正更新或失败的包各显示一条最终结果；未变化、已固定和已是最新的包不显示、不计入默认摘要；没有实际更新或错误时仅输出 `All packages are up to date.`，不再重复打印结果表格或 Completed。`outdated`、`status` 和更新预览同样只展开有变化／受阻的条目。`--verbose` 才保留全部阶段日志、完整包表和原因。精确版本请求仍保持固定，不因界面改动自动升级。

`info` 默认显示来源、最新／请求版本、依赖问题和已安装版本，不输出完整收据；`source list`、`command list` 使用精简表格，`cache list` 按缓存类别汇总数量，`--verbose` 再展开路径／版本明细。搜索和列表不再重复打印每次相同的使用提示。执行代码、数据删除、系统集成等审批预览和恢复协议保持原样，安全警告及失败原因不省略。

- 进度写 stderr，最终结果写 stdout。默认在管道、重定向、CI 或 `TERM=dumb` 环境中关闭动态进度，避免转义字符污染日志。
- `--progress always` 可在重定向环境输出纯文本下载进度；配合 `--verbose` 输出全部阶段日志。`--progress never`／`--no-progress` 关闭进度。
- `--color auto|always|never` 控制交互终端配色；`--no-color` 和 `NO_COLOR` 优先禁用颜色，关闭颜色不影响进度信息。
- `install`、`update`、`outdated`、`status`、`list`、`search`、`info`、`source list`、`command list`、`cache list` 支持 `--json`。该选项关闭进度，在 stdout 保留原始结构化数据（含未变化的包）；安全警告与错误仍会写 stderr。解析列表的脚本必须使用 `--json`，新机引导脚本已同步。其他审批／恢复命令保留既有输出协议。

```powershell
piko install main/node@latest
piko update --all
piko update --all --dry-run --json
piko install main/node@latest --progress always --verbose 2>install.log
piko search node --no-color
```

支持精确版本、`latest`、语义主/次版本简写和软件源声明的渠道别名；预发布需精确版本或源显式指定，非标准版本不推断语义范围。安装不改变 default/current，更新成功后切换并保留旧版；普通卸载默认版本会拒绝，`--force` 会清除该默认和相关入口，不自动选替代版本。批量更新不是全包原子事务；失败继续其他包，总退出码为 1，失败包保留旧默认。

## 运行时渠道与发行版

版本别名由软件源的 `index.json` 包条目声明，与命令别名不同。例如下面的条目片段要求源已经登记 24.x／22.x 的版本：

```json
{
  "aliases": { "lts": "24", "lts-22": "22" },
  "runtime": { "family": "node", "distribution": "official" }
}
```

```powershell
piko install main/node@lts
piko use main/node@lts
piko update main/node           # 保留 lts 请求，按源当前映射更新
piko info main/node@lts
```

别名只映射到已登记的精确版本或主/次版本请求，不支持递归、链式跳转或重定义 `latest`。`use` 只选择已安装版本；解析渠道时会刷新原始源，不自动安装。依赖字段也可使用其来源声明的版本别名。现有固定 Node 26 示例没有被擅自标为 LTS；渠道由可信源维护，客户端不查询上游发布。

JDK 等发行商按独立包保存身份，例如源中 `java-temurin` 的索引条目声明 `runtime: { "family": "java", "distribution": "temurin" }` 后可用：

```powershell
piko install main/java@21 --distribution temurin
piko use main/java@21 --distribution temurin
piko info main/java --distribution temurin
```

该选择解析到 `main/java-temurin`；不同发行商不共享版本目录，不会隐式换发行商或接管 `java` 命令。多个源同名发行版时须指定来源。源未登记的 JDK 发行版不会凭空出现；这项客户端能力不等于已提供全部运行时清单。

## 更新检查与预览

`outdated [包]`、`status [包]` 和 `update --all --dry-run` 会查询默认包的原始来源，展示当前版本、保存的请求、候选版本、源的 latest 及状态：`pinned`、`current`、`outdated`、`downgrade` 或 `blocked`。单包也可用 `update <包> --dry-run`。某包受阻继续检查其他包，CLI 遇受阻项退出码为 1。

不安装、不切换默认、不改变命令归属或状态文件；查询可更新本地源／npm 缓存。便携候选还检查摘要声明、依赖、启用命令／别名和环境冲突，但不下载分发文件，因此预览不能保证后续下载与安装成功。npm 查询仍需要已选择且符合要求的受管理 Node/npm；registry 改变会受阻。未选默认的版本不自动纳入更新。

## 旧安装版本清理

```powershell
piko cleanup main/node --versions --keep 2 --dry-run
piko cleanup main/node --versions --keep 2 --yes
piko cleanup --versions --keep 1 --dry-run   # 所有已登记包
# 将预览中的 binding 用于自动化确认；内容变化会拒绝：
piko cleanup main/node --versions --keep 0 --yes --binding <hash>
```

`--keep N` 表示除默认版本外再保留 N 个版本，默认 N=1；默认版本始终保护，N=0 也不删除它。标准语义版本按版本从高到低排序，其他版本标识按数字感知的字符串排序（不代表上游发布时间），请核对预览。只卸载已登记且收据一致的版本，保留 persist 数据，不清理缓存，也不扫描未知目录；不与 `--data` 混用。

执行前和每次卸载持锁时重新检查目标，默认或收据漂移会拒绝。逐项沿用已有卸载日志恢复，不是全包原子操作；失败项列明错误，其他项继续。没有传 `--yes` 不删除任何版本。

## 整机软件清单导出／恢复

```powershell
piko export piko-software.json          # 拒绝覆盖已有文件；省略路径则输出 JSON
piko export piko-locked.json --lock     # 附带经校验的 npm 传递依赖锁图
piko import piko-software.json --dry-run
piko import piko-software.json --yes
piko import piko-software.json --yes --binding <预览返回的 hash>
```

清单记录源 URL／类型／ref、各包已安装的精确版本、所选版本与原始更新请求、启用命令和命令别名；不复制机器专属 state.json、路径、程序文件、用户数据、凭据或脚本批准。默认拒绝导出未校验安装，以及含认证信息、查询参数或片段的源／registry URL，不悄悄删掉参数导致换源。SSH 的标准 `git` 用户名可保留，认证需在目标机器独立配置。

恢复预览刷新源、核对版本／清单、检查源身份、默认、命令／别名、环境与显式依赖冲突，并展示安装顺序。只有 `--yes` 才新增源、安装或选择版本；来源和已有默认不一致时先要求用户显式解决，不隐式覆盖。普通依赖须在文件中明确带有兼容的默认选择或已在目标环境满足，按依赖顺序恢复；npm CLI 前需要已选 Node 或文件中明确选定的 Node。源渠道由导出时保存的请求继续跟踪，但首次恢复的是导出的精确版本。

恢复包含逐步提交，不是整机事务。中断时已完成步骤保留，可重新预览后重试；会检查状态 revision 与已确认清单摘要，变化后停止。不同旧版本依赖互不兼容的默认运行时、缺失版本或依赖环会明确阻止恢复，需要用户调整清单，不临时偷偷切换依赖。npm 恢复不导入脚本批准；普通导出不锁完整传递依赖树，`export --lock` 的导出则通过 `npm ci` 恢复同一 lockfile v3 并核对锁图。目标机需显式配置匹配的 `PIKO_NPM_REGISTRY`／`PIKO_NPM_SCOPED_REGISTRIES`，凭据不导出。

## 命令归属与别名

```powershell
piko use other/tool@1 --no-commands
piko command claim tool other/tool
piko command release tool
piko command alias format-code npm:prettier prettier
format-code --version
piko command list
piko command unalias format-code
piko doctor
```

claim 需要目标已选择默认且提供该真实命令；不静默覆盖别名。别名跟随默认版本，不支持递归或 Shell 命令字符串。已转移/释放的命令不会因原包 use/update 被抢回。`--no-commands` 释放该包的普通命令，保留 current 和别名。

`doctor` 列出文件查找顺序、实际命中及预期 shim；`use` 对遮蔽告警。外部文件不改变。PowerShell 别名/函数须额外用 `Get-Command <name> -All` 检查；诊断不会替父 Shell 改 PATH。

## 环境变量与数据

平台分发项支持声明式 env：

```json
{
  "env": {
    "TOOL_HOME": "{root}",
    "TOOL_DATA": "{persist}",
    "TOOL_VERSION": "{version}"
  }
}
```

所有默认包的变量合并到受管理程序及其子进程；只支持上述占位符。冲突值、大小写重名、PATH、PIKO_*、NPM_CONFIG_*、NODE_OPTIONS 等受保护变量会拒绝。不会更改父 Shell 或注册表，也不自动建立 env 中提到的数据目录。

普通卸载保留清单声明的 persist 数据，回退程序不回退数据。

```powershell
piko cleanup main/example --data --dry-run
piko cleanup main/example --data          # 交互输入 DELETE
piko cleanup main/example --data --yes   # 非交互显式确认永久删除
```

所有安装版本卸载后才能清理，只删除记录的目录，保留同层未知文件；链接漂移或非预期 junction 会拒绝。旧版已经卸载且没有留下所有权记录的数据不自动接管；不扫描外部 Documents/AppData。

## 全新聊天／浏览器资料放入 persist

`piko persist` 为已安装并选择的 Tabbit、钉钉、微信和企业微信提供显式的当前用户数据目录接管。它不导入旧数据：关闭相关应用，先预览，再以绑定摘要批准；现有目录只改名归档到同目录的 `.piko-before-<操作标识>`，新目录用 junction 指向 `persist/<软件>/profile/<槽位>`。企业微信和微信的数据路径注册表值使用比较后写入并保存原值，撤销时恢复。企业微信已有的自定义数据目录不搬动、不删除。

```powershell
piko persist main/dingtalk --fresh --dry-run
piko persist main/dingtalk --fresh --yes --binding <摘要>
piko persist main/tabbit --fresh --dry-run
# 只有关闭浏览器所有后台进程后才能批准
piko persist main/dingtalk --remove --dry-run
piko persist main/dingtalk --remove --yes --binding <新的摘要>
piko persist --recover # 仅用于中断日志前滚恢复
```

原目录是当前 Windows 用户的全局路径，旧应用副本也会看到新资料；不并发使用旧、新客户端。旧资料保留在归档目录，不自动删除；撤销恢复原目录并保留 Piko 新资料。运行进程、未知链接、目标冲突、注册表或归档目录漂移会阻止操作。journal 未完成时阻止普通命令；用 `persist --recover` 处理，不手工删日志。接管收据位于 `apps/piko/data-profiles.json`；卸载／清理前须显式撤销。不要换回不识别这些收据的旧 Piko 构建。

这是固定目录／配置值重定向，不是容器或沙箱，不保证应用的日志、缓存、系统组件及任意用户选定路径全部位于 persist。浏览器凭据可能绑定旧 EXE 加密身份，不迁移、不解密。新账号登录、跨版本数据库兼容、GUI 实际写入与应用自更新须独立验收。原清单已有包内 `persist` 的软件仍按清单执行。

## 软件源声明的 Shell 初始化

支持 PowerShell 与 Git Bash 分别声明、分别批准。Bash 使用 `shell.bash`，接入时指定 `--shell bash --profile <UTF-8文件>`；不自动翻译现有 PowerShell 初始化。`piko shell env --shell powershell|pwsh|cmd|bash|json` 另行输出默认环境文本，不执行软件初始化或修改父 Shell。

清单平台项可声明 `shell: { "powershell": "初始化脚本文本" }`。安装／更新只保存声明，不执行它，也不改 Profile。初始化在新 Shell 的当前作用域执行，因此 z.lua 的 `z` 能改变当前目录；不是靠子进程改变父目录。软件专用逻辑放在独立源 `../piko-source/packages/`，客户端不识别软件名。

```powershell
piko install main/lua@5.5.0
piko use main/lua@5.5.0
piko install main/z.lua@1.8.26
piko use main/z.lua@1.8.26
piko integrate main/z.lua --shell pwsh --dry-run
# 阅读输出内容、依赖路径及 binding；用输出的真实摘要替换 <hash>
piko integrate main/z.lua --shell pwsh --approve-shell --binding <hash>
```

`--shell powershell` 对应 Windows PowerShell 5.1，`pwsh` 对应 PowerShell 7；默认查询所选 Shell 的 `$PROFILE.CurrentUserAllHosts`。可用 `--profile <path>` 显式指定文件。仅当前用户，不修改所有用户配置，不放宽 ExecutionPolicy。`--yes` 不能代替 `--approve-shell`，必须提交预览 binding。使用前需执行编译 EXE 的 `setup`。

每份 Profile 仅插入一个带根目录标识的加载块；保存旧文件备份，保留块外内容、UTF-8／UTF-16LE BOM 与换行。其他编码拒绝，管理块被修改或预览后文件变化则停止。新建／生成的路径表达式为 ASCII，支持 5.1 的 Unicode 路径；输出按 UTF-8 解码。写入与状态记录使用恢复日志，`piko recover`／`doctor` 可恢复。恢复先检查整份日志的路径、唯一目标、相同起始 revision、托管块归属，并重新执行纯文本编辑推导前后字节；不接受块外替换。所有 Profile 的外部字节均预检通过后才开始恢复，冲突则保留现场。

源侧初始化可以使用 `$PikoPackageRoot` 和 `$PikoDependencies['lua']` 等变量。依赖来自同源或声明源的受管理默认版本和命令归属，不按 PATH 猜解释器。Shell 依赖支持精确、主／次版本、`latest` 和源侧版本别名；初始化只读取并校验本地源索引，不在打开终端时联网。索引缺失或不匹配时停止加载。

批准绑定来源、初始化文本、包非持久化文件树以及选定依赖内容。更新、切版本或依赖变更后不匹配就跳过并告警，需要重新预览授权；切回获准内容可恢复。`unuse` 停止新会话加载，卸载非默认旧版不影响集成，最后一个版本卸载时撤销所属集成并移除空加载块。已运行会话的函数／模块不会自动卸载。

```powershell
piko unintegrate main/z.lua --shell pwsh --dry-run
piko unintegrate main/z.lua --shell pwsh --yes --binding <hash>
```

**初始化和导入模块拥有完整用户权限，不是沙箱。** 持久化数据不纳入初始化摘要；源必须避免把可变数据当受校验代码加载。第三方脚本产生的外部副作用无法自动撤回。已有 Scoop／手工初始化应先人工核对，Piko 不删除未知代码。导出只保存包的 PowerShell 集成意图，不复制 Profile 路径、内容或批准；恢复返回 `pendingIntegrations`，目标机重新接入授权。

原生 `bin` 增加 `.com`（Windows 可执行文件，不是 DOS 程序），`kind: "powershell"` 支持 `.ps1`。后者由 Windows PowerShell `-NoProfile -File` 作为子进程执行，保留参数和退出码，不更改执行策略；不等同于当前 Shell 的 dot-source 或 PowerShell 对象管道。需要父 Shell 函数／模块的功能使用上述初始化机制。

## 文件持久化与配置模板

原有 `persist: ["data"]` 继续表示目录 junction；新增文件对象：

```json
{
  "persist": [
    { "path": "config.ini", "kind": "file", "mode": "seed", "initial": "" },
    "history"
  ],
  "configTemplates": {
    "config.ini": { "text": "[General]\nconfig={{persist}}/config.ini\n" }
  }
}
```

`seed` 只在持久化目标不存在时创建初始 UTF-8 文本，再由应用自身配置重定向访问；Snipaste 清单采用这个方式。模板仅替换 `{{persist}}`／`{{app}}` 为正斜杠路径，不执行表达式；当前为原始文本模板，JSON／XML 等需要额外转义的格式应由源负责，不能任意套用。生成文件不能覆盖已提取文件，冲突明确失败。

`mode: "hardlink"` 将应用内文件链接到持久化文件；已有数据优先，卸载仅移除链接。应用原子替换文件会断开硬链接，Piko 在再安装、选用和卸载时检查文件身份，发现分叉则停止，保留两份文件待人工核对，不静默同步。LocalSend 尚未完成实际保存行为验收，因此未发布其清单。文件／目录及映射模式不能跨版本静默改变。

文件数据沿用 `cleanup --data` 的显式预览和确认。Shell／文件持久化元数据至少使用 state schema 5，外部集成使用 schema 6；旧 schema 1–5 仍可读取，使用新功能后不要直接换回不支持 schema 6 的旧 EXE。

## 用户级桌面集成与显式引导

平台项 `desktop` 可声明 `environment`、`path`、`shortcuts`、`fonts`、`menus`、`associations`。其中 **`shortcuts` 随已校验的 GUI 安装自动创建**，不需另行 `integrate`：当前用户开始菜单 `Programs\Piko Apps` 保存真实 `.lnk`，直接指向应用 EXE，工作目录为 EXE 所在目录，不指向 `.shim`。安装不自动选择 CLI 默认版本；未选择默认时，新装 GUI 提供入口；已有默认时，安装候选不抢入口，`use`／更新／回退同步切换，卸载入口所属版本时改用剩余版本或移除。重复 `install` 可通过同一安装流程登记旧安装的快捷方式，不重新下载载荷。同名外部快捷方式及用户修改不覆盖，冲突报错；安装未成功时保留可恢复日志，不假报成功。

快捷方式所有权记录在 state 的 `startMenu`，变更并入 selection journal，失败／中断会校验后恢复。**仅快捷方式自动创建**；字体、环境变量、PATH、右键菜单、文件关联和服务仍不自动启用。其余桌面效果先 `use` 再单独预览授权：

```powershell
piko integrate main/llvm --desktop --dry-run
piko integrate main/llvm --desktop --yes --binding <预览摘要>
piko unintegrate main/llvm --desktop --dry-run
piko unintegrate main/llvm --desktop --yes --binding <预览摘要>
```

- `environment` 沿用受保护变量检查和 `{root}`／`{persist}`／`{version}`，写当前用户 HKCU Environment，不改 HKLM；`{root}` 使用稳定 current。`path` 是包内相对目录列表（`.` 表示根），只在用户 PATH 附加必要段，撤销只移除自己加入的段，保留其他软件和后续用户改动。
- `shortcuts` 声明 `{name,path,args?}`，安装时在当前用户开始菜单 `Piko Apps` 子目录生成真实 `.lnk`。目标只允许包内 EXE／COM，参数按 Windows argv 规则引用，不拼接 Shell；已有外部同名文件不覆盖。旧版显式 `integrate --desktop` 的 `Piko` 子目录收据仍按原规则保留／撤销，避免破坏既有所有权；新安装无需该授权来获得快捷方式。
- `fonts` 是确切 TTF／OTF 文件列表。检查签名后复制到当前用户字体目录，以独立名称写 HKCU Fonts 并刷新字体资源；不覆盖原 Scoop 字体，不自动更改终端字体设置。需要 Windows 10 1809+；字体被占用时可能需关闭应用或重新登录，失败保留恢复日志。
- `menus` 声明 `{id,label,target,path,args?}`；`target` 为 `file`／`directory`／`background`，只登记独立 HKCU Classes 右键命令。`associations` 声明 `{extension,label,path,args?}`，提供 Open With 项，**不绕过 Windows UserChoice 或强抢默认应用**。这不是 COM Shell 扩展注册。
- 资源变更保存原值、所有权和内容摘要，写入前重查；失败或中断按 journal 恢复。恢复会按安装收据和原声明重新推导操作，拒绝重复目标、未声明资源、异常 revision 或不一致的替换值；提交后的撤销也校验原归属。先预检所有外部资源与所需备份内容，再逐项写入并再次检查并发变化，冲突则停止并保留日志。这不是跨文件／注册表事务。注册表空键可能保留，不删除用户未知内容。执行广播不等于已运行终端／IDE 的环境立即更新。
- 桌面声明和实际外部效果不变时，更新／切版／回退自动延续已有所有权收据；文件缺失、资源漂移或字体字节改变仍拒绝。声明／效果变化时，先安装候选，再 `integrate <包>@<新版> --desktop --upgrade --dry-run`，以 `--yes --binding <摘要>` 一次确认变更资源和默认切换；失败恢复旧资源，外部用户修改不覆盖。卸载活动版本前仍需撤销。Shell 初始化继续使用独立内容绑定机制。

### reset：重建入口与数据映射

类似 Scoop 的修复入口，使用当前已安装收据，不联网、不下载、不重装、不切换版本：

```powershell
piko reset main/listary --dry-run # 查看待修复项
piko reset main/listary           # 修复一个软件
piko reset --all --dry-run        # 统一预览
piko reset --all                  # 修复全部软件
```

修复范围：缺失的 EXE／`.shim`、受管理命令别名、开始菜单 `Piko Apps` 下的 `.lnk`、默认版本 `current` junction、包内 persist 目录 junction／文件 hardlink，以及已经通过 `piko persist --fresh` 批准的外部资料链接和缺失的目录配置值。`--all` 还修复 Piko 自身 shim。已释放的命令不会重新抢占。未登记快捷方式的旧 GUI 安装也可直接 reset，无须重复安装。

**data 指修复映射，不是清空或重新初始化数据。** persist 实体数据必须仍然存在；缺失则停止，要求从备份恢复，不用空目录或初始配置掩盖数据丢失。seed 数据保留，不覆盖包内独立的配置模板文件；reset 不是通用程序文件恢复器。外部数据重定向必须已有批准收据，不会自动接管新路径；相关应用运行时阻止缺失外部数据路径的修复。

已有健康资源不改写；外部同名快捷方式、被改写的 shim、错误指向的链接、独立替换的配置文件和变更后的注册表值均拒绝覆盖，保留两份供人工处理，不提供 `--force`。修复仅增加缺失链接，意外中断可重跑；快捷方式写入使用 selection journal 恢复。实际修改前预检全部目标，但文件、链接和注册表不是跨资源原子事务。不会重新执行 Shell 初始化、安装器、服务或驱动配方，也不修改用户 PATH。

### 原生命令安装与统一验收

新电脑安装只需要发行版 `piko.exe` 与软件源，不依赖仓库 `.tools/*.cjs`。下载／解包、选择默认、批准 Shell 初始化与引导是独立步骤；先完成一批安装，再统一检查，不必逐包运行迁移辅助脚本：

```powershell
# 使用已配置的软件源；版本根据该机器的选择指定。
$packages = @('main/starship', 'main/z.lua', 'main/psfzf', 'main/sudo', 'main/llvm')
foreach ($package in $packages) {
    piko install $package
    if ($LASTEXITCODE -ne 0) { throw "安装失败：$package" }
    piko use $package
    if ($LASTEXITCODE -ne 0) { throw "选择失败：$package" }
}
piko doctor
```

`z.lua` 需要先安装并选择 Piko 的 Lua，`PSFzf` 需要先安装并选择 fzf；也可用已有的 `install --with-deps --dry-run`／`--yes --binding` 审批依赖计划。Shell 初始化另用 `integrate --shell pwsh --dry-run` 与 `--approve-shell --binding`，不在安装阶段静默执行。已有手写初始化需用户移除冲突行，Piko 不猜测或覆盖个人 Profile。`doctor` 在无待恢复操作时只诊断，不增加状态 revision；存在恢复日志时仍执行安全恢复。

Rust 的全新安装沿用下一节的 `install → bootstrap → use`，之后再显式安装需要的工具链。复制旧工具链／缓存属于旧机器的数据迁移，不是新电脑安装的前置条件。CLI 端到端回归 `tests/native-workflow.test.ts` 从空根开始，仅用公开命令安装一批夹具，再统一验证引导、依赖、5.1／7 Shell 初始化与命令入口。

### bootstrap：安装器／工具链引导例外

平台项 `bootstrap` 声明 `{path,kind?,args,env?,outputs}`。`path` 必须是包内非持久化 EXE，或 `kind: "powershell"` 的 PS1；命令使用参数数组。`outputs` 必须位于已声明持久化目录。生成原生命令用 `bin: {name:{path,kind:"native",data:true}}` 指向对应输出，只有成功引导后才能选择或启动。它是明确的可执行／可变数据例外，不用于解压辅助工具。

```powershell
piko install main/rustup@1.29.2
piko bootstrap main/rustup --dry-run
piko bootstrap main/rustup --approve-exec --binding <预览摘要>
piko use main/rustup@1.29.2
```

`--yes` 不能代替 `--approve-exec`。批准绑定来源、包非持久化内容、参数和声明环境。执行前记录 running，之后记录 completed／failed；崩溃不会在 recover 时自动再次运行。失败保留部分持久化数据，需重新预览重试，外部副作用不保证回滚。获准代码拥有完整用户权限，可联网；Piko 不校验它内部下载的字节。PowerShell 不自动绕过执行策略。

rustup 配方使用独立 CARGO_HOME／RUSTUP_HOME、`--no-modify-path --default-toolchain none`：只引导管理器，不擅自装 Rust 工具链／MSVC／SDK。选择后可自行 `rustup toolchain install stable`、`rustup default stable`，现在也可使用 `piko rust list` 及 `piko rust install|use|update|remove <工具链>` 统一管理，变更先 `--dry-run`，再用 `--approve-exec --binding <摘要>`。`use` 只选已安装工具链，默认工具链删除受保护，操作绑定受管理 rustup 和隔离 homes。rustup 仍负责下载／组件校验，生成命令是可变数据，不视为固定源载荷。

### system：管理员集成例外

平台项 `admin` 必须同时提供 `install`／`remove`，两者使用与 bootstrap 相同的可执行声明。服务、驱动或 COM 扩展需要源提供明确配方，不把整个 Scoop 脚本直接导入。

```powershell
piko system main/flclash --dry-run
# 用户自行打开提升权限的终端，并确认使用同一个 PIKO_HOME
piko system main/flclash --approve-admin --binding <预览摘要>
piko system main/flclash --remove --dry-run
piko system main/flclash --remove --approve-admin --binding <新的预览摘要>
```

必须单独 `--approve-admin` 并已处于管理员终端；**不自动 UAC 提权，不自动打开防火墙、不启用系统功能、不重启 Explorer／系统**。预览含脚本、参数和内容摘要。系统执行不是沙箱或事务；失败／运行中记录会阻止卸载，需检查后按配方撤销／重试。活动系统集成仍绑定具体版本；安装候选后可用 `system <包>@<新版> --upgrade --dry-run` 合并预览旧撤销／新安装，再以单独 `--approve-admin --binding <摘要>` 执行。需要自行提升终端，记录阶段但不冒充事务；失败不自动重放脚本。

独立源已提供 FlClashHelperService 和 TortoiseSVN Shell 扩展配方：先拒绝外部现有服务／注册值／CommonProgramFiles 路径，保留配方自己的所有权记录；撤销只恢复拥有的值，不照搬 Scoop 的整树删除。TortoiseSVN MSI 的重复架构文件以 `files` 中 `#File表标识` 精确选择；无明确映射仍拒绝重名。

TortoiseSVN 配方修订 `1.15.0.29830-piko.1` 起，COM／overlay 直接指向独立版本目录，不再使用固定 `CommonProgramFiles` junction；安装候选及切换系统注册不删除旧版 DLL。客户端卸载／版本清理系统集成包前通过 Windows Restart Manager 检查加载的 EXE／DLL：占用版本预览为 `defer-in-use`，结果为 `deferred-in-use`，保留旧版并在用户自行注销／重启后重新清理。直接 uninstall 在移动目录前拒绝占用。检查失败不视为无人使用；仍有进程在检查后加载文件的竞争窗口，不保证消除一切共享锁。普通更新不会绕过活动系统集成的管理员批准。详见软件源 `guides/tortoise-svn.md`。配方的 HKCU 隔离注册切换与真实 DLL 占用检查已验证；**真实 HKLM 管理员实装、Explorer UI、服务／驱动验收仍未据此认证**。

以上新增元数据使用 **state schema 6**，仍可读 schema 1–5。导出只记录 desktop／bootstrap／system 意图，不带注册表旧值、Profile、用户数据或批准；目标机重新审核。需要 bootstrap 生成命令的默认选择会明确阻止自动恢复，须先单独安装／批准引导再选择。

## npm 脚本

安装前必须显式选择受管理 Node/npm，不能回退系统 npm 或自动装 Node。安装要求 npm >=11.20.0，以保留依赖来源控制。执行脚本先用实际 npm 运行自有无害夹具，确认允许／显式拒绝策略被执行后才处理真实已批准脚本，不再以精确版本白名单放行。Git/本地目录/文件/任意远端 tarball spec 仍拒绝。`PIKO_NPM_REGISTRY` 指定默认源，`PIKO_NPM_SCOPED_REGISTRIES` 以 JSON 指定 scope → URL；各包保留实际 registry 身份，更新／重建不静默换源。

```powershell
piko scripts list npm:example-cli@1.2.3
piko scripts approve npm:example-cli@1.2.3  # 展示内容并输入 APPROVE
piko scripts rebuild npm:example-cli@1.2.3
piko scripts revoke npm:example-cli@1.2.3
# 依赖必须逐项批准，路径取自 list：
piko scripts approve npm:example-cli@1.2.3 --package-path node_modules/example-dependency
# 自动化绑定预先审查指纹，内容变化即拒绝：
piko scripts approve npm:example-cli@1.2.3 --binding <hash> --yes
```

approve 本身不执行，rebuild 才从已校验原始快照构建暂存副本；依赖默认为 false，版本/来源/快照/脚本绑定，升级不继承批准。失败不替换工作安装；撤销不删除已生成文件或撤销外部影响。0.4.0 支持批准后的显式 prepare 和私有依赖 .bin，不自动触发 prepare 的前后事件，也不公开传递依赖命令。相同 tarball 重复安装的路径粒度批准仍拒绝。

**这不是安全沙盒。** 获准代码以当前用户权限执行，可读写用户文件、联网和调用依赖。offline 只约束 npm 自己。真实原生模块和 pi 登录/模型调用尚未全面验证；新安装／重建记录实际存在的传递依赖 engines.node 和原生 .node 文件／Node ABI；执行检查这些约束，ABI 不匹配时给出重建／重装指引。检查是保守的，不承诺所有 Node-API 或原生模块均已真实验收。

## 缓存与恢复

```powershell
piko cache list
piko cache clean --dry-run
piko cache clean --yes
piko maintenance orphans
piko maintenance quarantine --dry-run
piko maintenance quarantine --yes
piko recover
piko recover --force
```

缓存清理保留已安装版本依赖的原始 npm 快照。绕过校验只对本次指定便携版本有效，不使用或写入可信下载缓存，后续仍校验；npm 不接受绕过。缓存损坏明确失败。

安装提交中断后按 journal **继续完成登记但不选默认**；未写入合法 journal 的目录不自动删除。maintenance 只隔离具有合法收据的未登记安装，不自动采纳或删除未知目录，持久化数据保留。恢复写锁需要原 owner 已退出，不按超时抢锁。

## Piko 自升级

```powershell
piko self update D:\downloads\piko.exe --sha256 <可信摘要> --yes
piko self status
piko self rollback --yes
```

旧版没有 self update 时，可从可信新版 EXE 对目标 PIKO_HOME 发起。候选先匹配可信摘要，再检查状态兼容，父进程退出后由独立 helper 替换程序并重绑已有 shims。state.json 不重写，Piko 仍不分版本、不设自身 current，固定 backup.exe 只供兼容回退。升级/回退是异步操作，用 self status 查看终态。

占用或中断时保留 journal、旧程序和 helper；使用返回路径中的 **helper.exe self recover** 继续，`--force` 恢复旧程序并仅在 owner 已死亡时清理锁。不要终止活 owner 或修改 schemaVersion。旧版无法读新状态时拒绝回退。升级 staging 工作目录保留作诊断，cache clean 不会扫描删除它。

## 布局

```text
<PIKO_HOME>/
  apps/piko/piko.exe
  apps/piko/state.json
  apps/piko/backup.exe           # 完成过升级后才有
  apps/piko/helpers/7zip/       # 首次需要非 ZIP 归档解压时自动准备的私有辅助工具
  apps/piko/helpers/innounp/    # 首次需要 Inno 解包时自动准备的私有辅助工具
  apps/<package>/<version>/     # 新安装使用可读包名/版本；npm 使用 npm- 前缀
  apps/<package>/current/       # 当前版本 junction；来源身份保存在内部元数据
  shims/                       # 4.5 KiB 原生 EXE + 同名 .shim，不再链接整个 Bun EXE
  persist/
  sources/
  cache/                       # artifacts + npm-input + npm 缓存
  staging/
  operations/
  quarantine/                  # 仅显式隔离后创建
  mutation.lock/
```

0.4.0 当前可读 schema 1–8；schema 8 用于可读软件／数据目录，schema 7 用于普通依赖记录、Bash Profile 与 npm 兼容元数据，写入后不要换回只支持 schema 6 的旧 EXE；env 和 Git 提交元数据使用 schema >=4，npm 内容批准使用 schema >=3，Shell／文件持久化使用 schema >=5，桌面／引导／管理员集成使用 schema 6。旧版会拒绝不支持的状态；没有原始快照的遗留 npm 安装需明确卸载重装才能批准，不把任意当前目录当可信输入。

## 验收与边界

```powershell
bun run smoke:real -- --pi
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-sandbox.ps1 -IncludePi
# Independent user integration acceptance, without upstream Node/npm downloads
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-sandbox.ps1 -IntegrationsOnly
```

`-IntegrationsOnly` 独立验证 Profile、用户桌面资源、恢复日志和 bootstrap，不运行基础 Node/npm 下载测试，也不能与 `-IncludePi` 同用。载荷为当前 Windows 字体与命令文件的私有校验副本，经沙盒回环 HTTP 下载；它们仅留在被忽略的 session 中，不作为可发布软件源。bootstrap 只生成测试文件和命令，不安装 Rust 工具链；管理员配方仅预览与拒绝普通确认，不执行安装。该镜像验证 PowerShell 5.1，PowerShell 7 仍需单独环境。

每轮生成独立 `.sandbox/<时间与随机标识>/piko.wsb`，双击启动自动验收。默认准备不启动；显式 `-Launch` 才启动。输入映射只读，结果目录单独可写，不映射仓库、用户目录或凭据，剪贴板关闭；安装与 PATH 修改仅在沙盒内。

最终以 `results/report.json` 的 `status=passed`、结束时间和退出码为准，窗口打印 PASS 不等于报告已发布。报告写入有短暂文件占用重试；旧报告和 pending 内容保留，不为绕过锁截断文件。沙盒内辅助脚本可双击检查网络或重跑，不需复制命令。结果作为不可信数据读取，不自动执行。

本机已测试 Git HTTP 安装/刷新、参数与标准流、退出码、隔离 Ctrl+C、内容批准、恢复、自升级和安装入口。尚缺 Windows 10 清洁 VM、PowerShell 7 沙盒、真实 Rust 工具链、管理员服务／COM／驱动、所有交互 TUI/原生模块及全格式沙盒验收。性能由 `docs/verification/performance.json` 记录。延迟加载避免 shim 初始化安装分支，完整快照文件摘要采用 16 路有界并发且保持旧批准指纹兼容；仍有 Bun 启动开销。

**待外部条件**：签名证书、正式发布仓库/权限和正式 HTTPS 软件源托管未提供。当前本地未签名包、固定目录和 CI 配置不等于已正式发布；远端 CI 尚未运行。macOS/Linux、原生 ARM64、系统 EXE/MSI 安装器、任意非 npm 源码构建、项目级环境和接管外部安装不属于本轮 Windows 首发范围。

设计与交付记录见 `CONTEXT.md`、`docs/design.md`、`docs/technical-plan.md`、`docs/stage-4.md`。当前支持范围以代码、实际验收和本 README 为准。
