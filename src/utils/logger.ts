import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
    private static outputChannel: vscode.OutputChannel;
    private static logLevel: LogLevel = 'info';

    static init(context: vscode.ExtensionContext): void {
        this.outputChannel = vscode.window.createOutputChannel('Mutagen');
        context.subscriptions.push(this.outputChannel);
        this.updateConfig();
    }

    static updateConfig(): void {
        const config = vscode.workspace.getConfiguration('mutagen');
        this.logLevel = config.get<LogLevel>('logLevel', 'info');
    }

    static show(): void {
        this.outputChannel.show();
    }

    private static shouldLog(level: LogLevel): boolean {
        const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
        return levels.indexOf(level) >= levels.indexOf(this.logLevel);
    }

    private static log(level: LogLevel, message: string): void {
        if (!this.shouldLog(level)) {
            return;
        }

        const timestamp = new Date().toISOString();
        const prefix = level.toUpperCase().padEnd(5);
        this.outputChannel.appendLine(`[${timestamp}] [${prefix}] ${message}`);
    }

    static debug(message: string): void {
        this.log('debug', message);
    }

    static info(message: string): void {
        this.log('info', message);
    }

    static warn(message: string): void {
        this.log('warn', message);
    }

    static error(message: string): void {
        this.log('error', message);
    }
}
