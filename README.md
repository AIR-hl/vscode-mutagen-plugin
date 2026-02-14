<h1 align="center">Remote-Mutagen Plugin for VS Code</h1>

<p align="center">
  <img src="assets/vscode-mutagen-plugin-logo.png" width="600" alt="Mutagen Logo">
</p>
<p align="center">  
  <a href="./README.md">简体中文</a> • <a href="./README_en.md">English</a>
</p>

这是一个 VS Code 扩展，用于以类似 Remote SSH 的体验来管理 [Mutagen](https://mutagen.io/) 文件同步会话。

起因是之前用`remote ssh`连接公司开发机服务器，但最近`codex`很强，却发现`codex`客户端无法像`cursor`一样连接ssh，而且公司服务器上封禁openai域名，因此需要反过来将远程文件同步到本地编辑，但是没一个`mutagen`会话管理工具，因此开发了本扩展。

## 功能特性

### 会话管理
- **会话列表视图**：在 Activity Bar 侧边栏查看所有 Mutagen 同步会话
- **创建会话**：通过引导式向导创建新的同步会话
- **会话操作**：暂停、恢复、终止、Flush、重置会话
- **配置编辑**：右键会话可编辑配置并自动“终止后重建”
- **会话详情**：在精美的 WebView 面板中查看会话详细信息

### 状态监控
- **实时状态**：状态栏展示整体同步状态（watching、syncing、errors）
- **传输速度**：在活跃传输期间显示上传/下载速度
- **自动刷新**：支持配置状态刷新间隔

### 配置与连接留存
- **全局 Ignore**：支持用户级 + 工作区级 ignore 叠加，避免大文件同步
- **连接档案自动保存**：创建/编辑会话后自动保存连接参数
- **自动恢复连接**：打开对应本地项目时自动恢复该项目保存的会话
- **关闭自动暂停**：关闭窗口或移除工作区时，自动暂停该项目对应会话，避免遗忘
- **手动连接入口**：侧边栏标题栏可直接连接已保存会话

### 可视化提示
- **状态图标**：针对 watching、syncing、paused、disconnected 等状态显示不同图标
- **错误提醒**：对存在错误或冲突的会话提供可视化标记
- **进度显示**：同步进行中以动效图标提示

## 使用

### 创建同步会话
1. 点击 Activity Bar 里的 Mutagen 图标
2. 点击 `+` 按钮，或运行 `Mutagen: Create Sync Session`
3. 选择需要同步的本地文件夹
4. 输入远端路径（支持以下格式）：
   - `host:/path` - 省略用户名，默认使用 `root`
   - `user@host:/path` - 指定用户名
   - `docker://container/path` - Docker 容器路径
5. 选择同步模式与相关选项

### 管理会话
- **暂停/恢复（仅当前项目）**：只有会话属于当前窗口项目时，才显示 pause/play 按钮
- **跨项目连接**：当会话不属于当前窗口项目时，显示“在当前窗口中连接”和“在新窗口中连接”
- **Flush**：点击同步按钮强制触发同步
- **终止**：点击垃圾桶图标移除会话
- **编辑配置**：右键 `Edit Configuration`，完成后自动重建会话（会话 ID 会变化）
- **查看详情**：点击 info 图标查看完整会话详情
- **连接已保存会话**：点击侧边栏顶部“插头”按钮

## 配置

| 设置项 | 默认值 | 说明 |
|---------|---------|-------------|
| `mutagen.executablePath` | `mutagen` | Mutagen 可执行文件路径 |
| `mutagen.refreshInterval` | `5000` | 状态刷新间隔（毫秒） |
| `mutagen.showStatusBar` | `true` | 是否在状态栏显示 Mutagen 状态 |
| `mutagen.autoStartDaemon` | `true` | 若 daemon 未运行，是否自动启动 |
| `mutagen.logLevel` | `info` | 日志级别（debug、info、warn、error） |
| `mutagen.globalIgnorePatterns` | `[]` | 全局 ignore（与工作区设置叠加） |
| `mutagen.autoSaveConnectionProfiles` | `true` | 是否自动保存连接档案 |
| `mutagen.autoRestoreConnections` | `true` | 打开工作区时是否自动恢复连接 |
| `mutagen.terminateRestoredSessionsOnClose` | `false` | 是否在关闭窗口/移除工作区时终止自动恢复会话（默认关闭，推荐使用自动暂停） |

## 命令

| 命令 | 说明 |
|---------|-------------|
| `Mutagen: Refresh Sessions` | 刷新会话列表 |
| `Mutagen: Create Sync Session` | 创建新的同步会话 |
| `Mutagen: Show Logs` | 打开 Mutagen 输出通道 |
| `Mutagen: Start Daemon` | 启动 Mutagen daemon |
| `Mutagen: Stop Daemon` | 停止 Mutagen daemon |
| `Mutagen: Connect Saved Session` | 手动连接已保存会话 |
| `Mutagen: Manage Saved Sessions` | 管理（连接/删除）已保存会话档案 |

## 致谢
- [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) - 强大的多Agent coding cli 工具
- [Mutagen](https://mutagen.io/) - 用于远程开发的高速文件同步工具
- [VS Code Extension API](https://code.visualstudio.com/api) - VS Code 扩展开发文档
