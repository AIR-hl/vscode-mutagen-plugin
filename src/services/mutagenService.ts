import * as vscode from 'vscode';
import * as cp from 'child_process';
import { Conflict, MutagenSession, DaemonStatus, CreateSessionOptions } from '../models/session';
import { Logger } from '../utils/logger';

export class MutagenService {
    private static instance: MutagenService;
    private executablePath: string = 'mutagen';
    private runningCommands = new Set<string>();

    private constructor() {
        this.updateConfig();
    }

    static getInstance(): MutagenService {
        if (!MutagenService.instance) {
            MutagenService.instance = new MutagenService();
        }
        return MutagenService.instance;
    }

    updateConfig(): void {
        const config = vscode.workspace.getConfiguration('mutagen');
        this.executablePath = config.get<string>('executablePath', 'mutagen');
    }

    private async execute(args: string[], commandKey?: string): Promise<string> {
        if (commandKey && this.runningCommands.has(commandKey)) {
            Logger.debug(`Command "${commandKey}" already running, skipping`);
            return '';
        }

        if (commandKey) {
            this.runningCommands.add(commandKey);
        }

        return new Promise((resolve, reject) => {
            Logger.debug(`Executing: ${this.executablePath} ${args.join(' ')}`);
            
            const proc = cp.spawn(this.executablePath, args, {
                env: { ...globalThis.process.env }
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                if (commandKey) {
                    this.runningCommands.delete(commandKey);
                }

                if (code === 0) {
                    resolve(stdout);
                } else {
                    const error = stderr || stdout || `Command failed with code ${code}`;
                    Logger.error(`Command failed: ${error}`);
                    reject(new Error(error));
                }
            });

            proc.on('error', (err) => {
                if (commandKey) {
                    this.runningCommands.delete(commandKey);
                }
                Logger.error(`Process error: ${err.message}`);
                reject(err);
            });
        });
    }

    async checkInstallation(): Promise<boolean> {
        try {
            await this.execute(['version'], 'version');
            return true;
        } catch {
            return false;
        }
    }

    async getVersion(): Promise<string> {
        try {
            const output = await this.execute(['version'], 'version');
            return output.trim();
        } catch {
            return 'unknown';
        }
    }

    async getDaemonStatus(): Promise<DaemonStatus> {
        try {
            const sessions = await this.listSessions();
            return { running: true, version: await this.getVersion() };
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            if (errorMessage.includes('unable to connect to daemon')) {
                return { running: false };
            }
            return { running: true };
        }
    }

    async startDaemon(): Promise<void> {
        await this.execute(['daemon', 'start'], 'daemon-start');
        Logger.info('Mutagen daemon started');
    }

    async stopDaemon(): Promise<void> {
        await this.execute(['daemon', 'stop'], 'daemon-stop');
        Logger.info('Mutagen daemon stopped');
    }

    async listSessions(): Promise<MutagenSession[]> {
        try {
            const output = await this.execute(
                ['sync', 'list', '--template', '{{json .}}'],
                'list'
            );
            
            if (!output.trim()) {
                return [];
            }

            const sessions = JSON.parse(output);
            return Array.isArray(sessions) ? sessions : [sessions];
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            if (errorMessage.includes('no synchronization sessions exist')) {
                return [];
            }
            throw err;
        }
    }

    async getSession(identifier: string): Promise<MutagenSession | null> {
        try {
            const output = await this.execute(
                ['sync', 'list', identifier, '--template', '{{json .}}']
            );
            
            if (!output.trim()) {
                return null;
            }

            const sessions = JSON.parse(output);
            return Array.isArray(sessions) ? sessions[0] : sessions;
        } catch {
            return null;
        }
    }

    async getSessionConflicts(identifier: string): Promise<Conflict[]> {
        const session = await this.getSession(identifier);
        return session?.conflicts ?? [];
    }

    async createSession(
        alpha: string, 
        beta: string, 
        options?: CreateSessionOptions
    ): Promise<string> {
        const args = ['sync', 'create', alpha, beta];

        if (options?.name) {
            args.push('--name', options.name);
        }
        if (options?.labels) {
            for (const [key, value] of Object.entries(options.labels)) {
                args.push('--label', `${key}=${value}`);
            }
        }
        if (options?.paused) {
            args.push('--paused');
        }
        if (options?.mode) {
            args.push('--mode', options.mode);
        }
        if (options?.ignoreVcs) {
            args.push('--ignore-vcs');
        } else if (options?.ignoreVcs === false) {
            args.push('--no-ignore-vcs');
        }
        if (options?.ignorePaths) {
            for (const path of options.ignorePaths) {
                args.push('--ignore', path);
            }
        }
        if (options?.symlinkMode) {
            args.push('--symlink-mode', options.symlinkMode);
        }
        if (options?.watchMode) {
            args.push('--watch-mode', options.watchMode);
        }
        if (options?.compression) {
            args.push('--compression', options.compression);
        }

        const output = await this.execute(args);
        Logger.info(`Created sync session: ${alpha} <-> ${beta}`);
        
        const match = output.match(/Created session\s+"?([^"\s]+)"?/i) || 
                      output.match(/([a-zA-Z0-9_]+)/);
        return match ? match[1] : '';
    }

    async recreateSession(
        identifier: string,
        alpha: string,
        beta: string,
        options?: CreateSessionOptions
    ): Promise<string> {
        await this.terminateSession(identifier);
        return this.createSession(alpha, beta, options);
    }

    async findSessionByIdentifier(identifier: string): Promise<MutagenSession | null> {
        return this.getSession(identifier);
    }

    async findSessionByEndpoints(localPath: string, remotePath: string): Promise<MutagenSession | null> {
        const sessions = await this.listSessions();
        for (const session of sessions) {
            const local = session.alpha.protocol === 'local' ? session.alpha : session.beta;
            const remote = session.alpha.protocol === 'local' ? session.beta : session.alpha;

            if (local.path !== localPath) {
                continue;
            }

            if (this.matchesRemotePath(remote, remotePath)) {
                return session;
            }
        }

        return null;
    }

    async pauseSession(identifier: string): Promise<void> {
        await this.execute(['sync', 'pause', identifier]);
        Logger.info(`Paused session: ${identifier}`);
    }

    async resumeSession(identifier: string): Promise<void> {
        await this.execute(['sync', 'resume', identifier]);
        Logger.info(`Resumed session: ${identifier}`);
    }

    async terminateSession(identifier: string): Promise<void> {
        await this.execute(['sync', 'terminate', identifier]);
        Logger.info(`Terminated session: ${identifier}`);
    }

    async flushSession(identifier: string): Promise<void> {
        await this.execute(['sync', 'flush', identifier, '--skip-wait']);
        Logger.info(`Flushed session: ${identifier}`);
    }

    async resetSession(identifier: string): Promise<void> {
        await this.execute(['sync', 'reset', identifier]);
        Logger.info(`Reset session history: ${identifier}`);
    }

    startMonitor(
        identifier: string,
        onUpdate: (session: MutagenSession) => void,
        onError: (error: Error) => void
    ): { stop: () => void } {
        const args = ['sync', 'monitor', identifier, '--template', '{{json .}}'];
        
        Logger.debug(`Starting monitor for session: ${identifier}`);
        
        const monitorProcess = cp.spawn(this.executablePath, args, {
            env: { ...globalThis.process.env }
        });

        let buffer = '';

        monitorProcess.stdout.on('data', (data) => {
            buffer += data.toString();
            
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const session = JSON.parse(line);
                        onUpdate(Array.isArray(session) ? session[0] : session);
                    } catch (e) {
                        Logger.debug(`Failed to parse monitor output: ${line}`);
                    }
                }
            }
        });

        monitorProcess.stderr.on('data', (data) => {
            Logger.error(`Monitor stderr: ${data.toString()}`);
        });

        monitorProcess.on('error', (err) => {
            onError(err);
        });

        monitorProcess.on('close', (code) => {
            if (code !== 0) {
                Logger.debug(`Monitor process exited with code ${code}`);
            }
        });

        return {
            stop: () => {
                monitorProcess.kill();
                Logger.debug(`Stopped monitor for session: ${identifier}`);
            }
        };
    }

    private matchesRemotePath(endpoint: MutagenSession['alpha'], remotePath: string): boolean {
        const normalizedRemotePath = remotePath.trim();
        if (!normalizedRemotePath) {
            return false;
        }

        if (endpoint.path === normalizedRemotePath) {
            return true;
        }

        if (endpoint.host) {
            const hostPath = `${endpoint.host}:${endpoint.path}`;
            if (hostPath === normalizedRemotePath) {
                return true;
            }

            const userHostPath = endpoint.user
                ? `${endpoint.user}@${endpoint.host}:${endpoint.path}`
                : hostPath;
            if (userHostPath === normalizedRemotePath) {
                return true;
            }
        }

        if (endpoint.protocol === 'docker' && endpoint.host) {
            const dockerPath = `docker://${endpoint.host}${endpoint.path}`;
            if (dockerPath === normalizedRemotePath) {
                return true;
            }
        }

        if (endpoint.host && normalizedRemotePath.endsWith(`:${endpoint.path}`)) {
            const hostSegment = normalizedRemotePath.slice(0, normalizedRemotePath.length - endpoint.path.length - 1);
            const normalizedHost = hostSegment.includes('@')
                ? hostSegment.substring(hostSegment.lastIndexOf('@') + 1)
                : hostSegment;
            if (normalizedHost === endpoint.host) {
                return true;
            }
        }

        return false;
    }
}
