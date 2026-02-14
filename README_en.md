<h1 align="center">Remote-Mutagen Plugin for VS Code</h1>

<p align="center">
  <img src="assets/vscode-mutagen-plugin-logo.png" width="600" alt="Mutagen Logo">
</p>
<p align="center">
  <a href="./README.md">简体中文</a> • <a href="./README_en.md">English</a>
</p>

A VS Code extension for managing [Mutagen](https://mutagen.io/) file synchronization sessions with a Remote SSH-like experience.

## Features

### Session Management
- **Session List View**: View all Mutagen sync sessions in the Activity Bar sidebar
- **Create Sessions**: Create new sync sessions with a guided wizard
- **Session Operations**: Pause, resume, terminate, flush, and reset sessions
- **Edit Configuration**: Edit session config from context menu with terminate-and-recreate flow
- **Session Details**: View detailed session information in a beautiful WebView panel

### Status Monitoring
- **Real-time Status**: Status bar shows overall sync status (watching, syncing, errors)
- **Transfer Speed**: Display upload/download speed during active transfers
- **Auto-refresh**: Configurable refresh interval for status updates

### Configuration and Persistence
- **Global Ignore**: User + workspace merged ignore patterns for large-file exclusion
- **Auto-save Profiles**: Connection profiles are saved automatically on create/edit
- **Auto-restore Connections**: Restore saved sessions when matching workspace is opened
- **Auto-pause on Close**: Pause sessions related to the closed/removed workspace automatically
- **Manual Reconnect Entry**: Connect saved sessions from the sidebar title button

### Visual Indicators
- **Status Icons**: Different icons for watching, syncing, paused, disconnected states
- **Error Alerts**: Visual indicators for sessions with errors or conflicts
- **Progress Display**: Animated icons during active synchronization

## Usage

### Creating a Sync Session
1. Click the Mutagen icon in the Activity Bar
2. Click the `+` button or run `Mutagen: Create Sync Session`
3. Select local folder to sync
4. Enter remote path (supports the following formats):
   - `host:/path` - Omit username, defaults to `root`
   - `user@host:/path` - Specify username
   - `docker://container/path` - Docker container path
5. Choose sync mode and options

### Managing Sessions
- **Pause/Resume (Current Project Only)**: Pause/play button appears only when the session belongs to this window's workspace
- **Cross-project Connect**: For foreign sessions, use `Connect In Current Window` or `Connect In New Window`
- **Flush**: Force sync by clicking the sync button
- **Terminate**: Click the trash icon to remove a session
- **Edit Configuration**: Right-click `Edit Configuration` (session will be recreated with a new ID)
- **View Details**: Click the info icon to see full session details
- **Connect Saved Session**: Click the plug button in the view title

### Keyboard Shortcuts
- `Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Windows/Linux) → Search for "Mutagen" commands

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `mutagen.executablePath` | `mutagen` | Path to the Mutagen executable |
| `mutagen.refreshInterval` | `5000` | Status refresh interval in milliseconds |
| `mutagen.showStatusBar` | `true` | Show Mutagen status in the status bar |
| `mutagen.autoStartDaemon` | `true` | Auto-start Mutagen daemon if not running |
| `mutagen.logLevel` | `info` | Log level (debug, info, warn, error) |
| `mutagen.globalIgnorePatterns` | `[]` | Global ignore patterns (merged with workspace settings) |
| `mutagen.autoSaveConnectionProfiles` | `true` | Automatically save connection profiles |
| `mutagen.autoRestoreConnections` | `true` | Auto-restore saved connections for opened workspaces |
| `mutagen.terminateRestoredSessionsOnClose` | `false` | Whether to terminate auto-restored sessions on close/workspace removal (disabled by default; auto-pause is recommended) |

## Commands

| Command | Description |
|---------|-------------|
| `Mutagen: Refresh Sessions` | Refresh the session list |
| `Mutagen: Create Sync Session` | Create a new sync session |
| `Mutagen: Show Logs` | Open the Mutagen output channel |
| `Mutagen: Start Daemon` | Start the Mutagen daemon |
| `Mutagen: Stop Daemon` | Stop the Mutagen daemon |
| `Mutagen: Connect Saved Session` | Connect a saved session manually |
| `Mutagen: Manage Saved Sessions` | Manage saved session profiles (connect/delete) |

## Acknowledgments

- [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) - Advanced multi-agent coding CLI tool
- [Mutagen](https://mutagen.io/) - Fast file synchronization for remote development
- [VS Code Extension API](https://code.visualstudio.com/api) - Extension development documentation
