#!/usr/bin/env node

import yaml, { Type } from "js-yaml";
import lodash from "lodash";
import log4js, { Logger } from "log4js";
import cron, { ScheduledTask } from "node-cron";
import child_process, { IOType } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { EOL } from "node:os";

process.on("exit", () => {
    DEBUG.debug("ServerInstance", ServerInstance);
    DEBUG.debug("ServerInstanceConfig", ServerInstanceConfig);
    DEBUG.debug("Main", Main.Instance);
});

const LOGGER = log4js.getLogger("server-starter");
const DEBUG = log4js.getLogger("server-starter-debug");
LOGGER.level = log4js.levels.INFO;
DEBUG.level = log4js.levels.OFF;

log4js.configure({
    appenders: {
        stdout: { type: "stdout" },
        stderr: { type: "stderr" },
        logfile: {
            type: "file",
            filename: "starterLogs/latest.log",
            maxLogSize: 32768,
            backups: 200,
            compress: true
        },
        defaultOut: {
            type: "logLevelFilter",
            level: "trace",
            appender: "stdout",
            maxLevel: "warn"
        },
        defaultErr: {
            type: "logLevelFilter",
            level: "error",
            appender: "stderr"
        },
        noLog: {
            type: "noLogFilter"
        }
    },
    categories: {
        default: {
            appenders: ["defaultOut", "defaultErr", "logfile"],
            level: "trace"
        },
        noLog: {
            level: "off",
            appenders: ["noLog"],
        }
    }
});
let configFile = "server-starter.yml";
let baseDir = ".";

function main() {
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg === "--config" || arg === "-c") {
            i++;
            configFile = process.argv[i];
            if (configFile == undefined) {
                console.error("invalid arg: %s", arg);
                process.exit(2);
                throw new Error();
            }
        } else if (arg === "--basedir" || arg === "-B") {
            i++;
            baseDir = process.argv[i];
            if (baseDir == undefined) {
                console.error("invalid arg: %s", arg);
                process.exit(2);
                throw new Error();
            }
        } else if (arg === "--debug" || arg === "-v") {
            console.info("[server-starter] 启用详细日志")
            LOGGER.level = log4js.levels.TRACE;
            DEBUG.level = log4js.levels.TRACE;
        } else {
            console.error("unknown arg: %s", arg);
            process.exit(2);
            throw new Error();
        }
    }
    LOGGER.info("baseDir: %s，configFile：%s", baseDir, configFile);
    Main.Instance.startScript();
    const stopCallback = () => {
        Main.Instance.stopScript();
    };
    process.on("SIGTERM", stopCallback);
    process.on("SIGINT", stopCallback);
    process.on("SIGHUP", () => {
        LOGGER.info("接收到SIGHUP信号，重新加载配置文件中");
        Main.Instance.reload();
    });
}

/**
 * 用于辨识数据的字段
 */
type ID = string;
/**
 * 用于辨识服务器进程的字段
 */
type ServerInstanceID = ID;
/**
 * 用于辨识服务器配置信息的字段
 */
type ServerConfigID = ID;
/**
 * 用于辨识服务器运行信息的字段
 */
type ServerRunID = ID;

type StarterSchedule = { cron: string } & StarterAction;
type StarterAction = { action: string, value?: any } & (
    StarterStopAllServerAction
    | StarterSignalServerAction
    | StarterStartServerAction
    | StarterStopServerAction
    | StarterRestartServerAction
    | StarterCmdAction
    | StarterStartAutoStartsServerAction
    | StarterStopScriptAction
    | StarterSendServerCommandAction
);

type StarterCmdAction = {
    action: "cmd"
    value: string
    timeout?: number
    cwd?: string
};
type StarterRestartServerAction = {
    action: "server-restart"
    server: string
    serverIndex?: number
}
type StarterStartServerAction = {
    action: "server-start"
    server: string
    serverIndex?: number
}
type StarterStopServerAction = {
    action: "server-stop"
    server: string
    serverIndex?: number
    forceStop?: boolean
}
type StarterSignalServerAction = {
    action: "server-kill"
    server: string
    serverIndex?: number
    value: NodeJS.Signals | number
}
type StarterSendServerCommandAction = {
    action: "server-command"
    server: string
    serverIndex?: number
    value: string
}
type StarterStopAllServerAction = {
    action: "stop-all-server"
}
type StarterStartAutoStartsServerAction = {
    action: "start-auto-starts-server"
}
type StarterStopScriptAction = {
    action: "stop-script"
}

type StarterServerConfig = {
    params: string | string[],
    "exec-option"?: any
    cwd?: string
    isMultiple?: boolean
    stdout?: "use" | "pass" | "ignore"
    stdin?: "use" | "ignore"
    stopCommands?: ServerInstanceConfigStopCommand[]
};

type ServerStarterConfig = {
    schedules?: StarterSchedule[];
    servers?: Record<string, StarterServerConfig>;
    autoStarts?: string[];
    autoRestarts?: string[];
    shell?: string | string[]
    commands?: Record<string, StarterAction>
    defaultCommandOutputServer?: string
};

async function readConfigFile(file: string = configFile): Promise<ServerStarterConfig | null> {
    const config: ServerStarterConfig = { servers: {} };
    try {
        const data = yaml.load(await fs.readFile(file, "utf8")) as any;
        const { schedules, servers, autoStarts, autoRestarts, shell, commands, defaultCommandOutputServer } = data as ServerStarterConfig;

        // verify autoStarts
        if (autoStarts != undefined && !Array.isArray(autoStarts)) {
            throw "autoStarts must be string[]";
        }
        config.autoRestarts = autoRestarts;

        // verify autoRestarts
        if (autoRestarts != undefined && !Array.isArray(autoRestarts)) {
            throw "autoRestarts must be string[]";
        }
        config.autoStarts = autoStarts;

        //verify shell
        if (shell != undefined && !(Array.isArray(shell) || typeof shell === "string")) {
            throw "shell must be string or string[]";
        }
        config.shell = shell;

        if (defaultCommandOutputServer!= undefined && typeof defaultCommandOutputServer !== "string") {
            throw "defaultCommandOutputServer must be string";
        }
        config.defaultCommandOutputServer = defaultCommandOutputServer;

        //verify schedules
        if (schedules != undefined && !Array.isArray(schedules)) {
            throw "schedules must be array";
        }
        schedules?.forEach((schedule, index) => {
            const { cron, action, value } = schedule;
            if (typeof cron !== "string") {
                throw `schedules[${index}].cron is not string`;
            }
            if (typeof action !== "string") {
                throw `schedules[${index}].action is not string`;
            }
        });
        config.schedules = schedules;

        // verify servers
        if (servers != undefined)
        Object.entries(servers).forEach(([name, serverInstanceConfig], index) => {
            try {
                if (name.length === 0) {
                    throw `servers[${index}] has an invalid server name`;
                }
                if (typeof serverInstanceConfig !== "object" || serverInstanceConfig == null) {
                    throw `servers[${name}] is not a valid config`;
                }
                const { cwd, "exec-option": execOption, params, isMultiple, stdout, stdin, stopCommands } = serverInstanceConfig as StarterServerConfig;
                if (typeof cwd !== "string" && cwd != undefined) {
                    throw `servers[${name}].cwd must be string`;
                }
                if (!Array.isArray(params) && typeof params !== "string") {
                    throw `servers[${name}].params must be string or array`;
                }
                if (typeof isMultiple !== "boolean" && isMultiple != undefined) {
                    throw `servers[${name}].isMultiple must be boolean`;
                }
                if (stdout != undefined && !["use", "pass", "ignore"].includes(stdout)) {
                    throw `servers[${name}].stdout must be "use", "pass" or "ignore"`;
                }
                if (stdin != undefined && !["use", "ignore"].includes(stdin)) {
                    throw  `servers[${name}].stdin must be "use" or "ignore"`;
                }
                if (stopCommands != undefined && !Array.isArray(stopCommands))
                    throw `servers[${name}].stopCommand must be array`;
                if (stopCommands != undefined)
                stopCommands.forEach((stopCommandItem, index) => {
                    if (!["mixed", "command", "signal", "kill"].includes(stopCommandItem.type)){
                        throw `servers[$name}].stopCommands[${index}].type must be "mixed", "command", "signal" or "kill"`;
                    }
                    if (typeof stopCommandItem.value !== "string" && typeof stopCommandItem.value !== "number") {
                        throw `servers[$name}].stopCommands[${index}].value must be string, number or NodeJS.Signals`;
                    }
                    if (stopCommandItem.timeoutMs != undefined && typeof stopCommandItem.timeoutMs !== "number") {
                        throw `servers[$name}].stopCommands[${index}].timeoutMs must be number`;
                    }
                });
                (config.servers as Record<string, StarterServerConfig>)[name] = serverInstanceConfig;
            } catch (e) {
                if (typeof e === "string") {
                    LOGGER.error("服务器配置%s无效：%s", name, e);
                } else {
                    LOGGER.error("无法加载服务器配置%s：", name, serverInstanceConfig);
                }
            }
        });
    } catch (e) {
        LOGGER.error("无法读取配置文件%s：", file, e);
    }
    return config;
}

function timeWait(timeoutMs: number) {
    return new Promise<void>(resolve => {
        setTimeout(() => resolve(), timeoutMs);
    });
}

let _uptime = 0;
const _startUptime = Date.now();

cron.schedule("* * * * * *", () => {
    _uptime += 1;
}, {
    "recoverMissedExecutions": false,
    "scheduled": true,
})
function getUptimeText() {
    const days = Math.floor(_uptime / (60 * 60 * 24));
    const hours = Math.floor(_uptime / (60 * 60) % 24 );
    const minutes = Math.floor(_uptime / 60 % 60);
    const seconds = Math.floor(_uptime % 60);

    const currentTimeDate = new Date();
    const currentTimeText = `${currentTimeDate.getHours()}:${currentTimeDate.getMinutes()}:${currentTimeDate.getSeconds()}`;

    return `${days} days, ${hours}:${minutes}:${seconds} (当前时间：${currentTimeText})`;
}

function firstArg(cmd: string){
   const pattern = /^(?:\s*)?(?:(?:"(.*?)(?<!\\)")|(\S+))/;
   const result = pattern.exec(cmd);
   if (result != null){
      return {
         arg: result[1] ?? result[2],
         subcommand: cmd.slice(result[0].length),
      }
   }
   return null;
}

function createID(length: number = 8): ID {
    const characters = "abcdefghjkmnpqrstuvwxyz23456789";
    let result = "";
    const charactersLength = characters.length;

    for (let i = 0; i < length; i++) {
        result += characters.charAt(
            Math.floor(Math.random() * charactersLength)
        );
    }

    return result;
}

type ServerInstanceConfigStopCommand = {
    /**
     * 指定不同的命令用于停止服务器
     * 
     * `command`: 向服务器发送命令  
     * `signal`: 向服务器发送指定的信号  
     * `kill`: 直接杀死服务器进程  
     * `mixed`: 先向服务器发送SIGINT信号(Ctrl+c)，等待1500ms后仍未结束则直接杀死进程  
     */
    type: "command" | "signal" | "kill" | "mixed"
    value?: string | NodeJS.Signals | number
    timeoutMs?: number
}

class ServerInstanceConfig {
    #name: string;
    #cwd: string;
    #params: string[];
    #execOption: any;
    #isMultiple: boolean;
    #stdout: "pass" | "use" | "ignore";
    #stdin: "use" | "ignore";
    #stopCommands: ServerInstanceConfigStopCommand[] = [];

    get name() {
        return this.#name;
    }
    get cwd() {
        return this.#cwd;
    }
    get params() {
        return this.#params;
    }
    get execOption() {
        return this.#execOption;
    }
    get isMultiple() {
        return this.#isMultiple;
    }
    get stdout() {
        return this.#stdout;
    }
    get stdin() {
        return this.#stdin;
    }
    get stopCommands() {
        return this.#stopCommands;
    }
    equals(o: any): boolean {
        if (!(o instanceof ServerInstanceConfig)) {
            return false;
        }
        if (o === this) {
            return true;
        }
        let myConfig: any;
        let yourConfig: any;
        {
            const { name, cwd, params, isMultiple, stdout, stdin, execOption, stopCommands } = this;
            myConfig = { name, cwd, params, isMultiple, stdout, stdin, execOption, stopCommands, };
        }
        {
            const { name, cwd, params, isMultiple, stdout, stdin, execOption, stopCommands } = o;
            yourConfig = { name, cwd, params, isMultiple, stdout, stdin, execOption, stopCommands, };
        }
        return lodash.isEqual(myConfig, yourConfig);
    }
    static addServerConfig(name: string, data: StarterServerConfig): ServerConfigID {
        const id = createID();
        const config = new ServerInstanceConfig();
        config.#name = name;
        if (data.cwd != undefined && path.isAbsolute(data.cwd)) {
            config.#cwd = data.cwd;
        } else {
            config.#cwd = path.join(baseDir, data.cwd ?? ".");
        }
        config.#params = typeof data.params === "string" ? [data.params] : data.params;
        config.#isMultiple = data.isMultiple ?? false;
        config.#stdout = data.stdout ?? "pass";
        config.#stdin = data.stdin ?? "use";
        config.#execOption = data["exec-option"] ?? {};
        config.#stopCommands = data.stopCommands ?? [{ type: "mixed" }];
        const oldConfigID = ServerInstanceConfig.RecordServerConfigNamed.get(name);
        const oldConfig = ServerInstanceConfig.RecordServerConfig.get(oldConfigID as any);
        if (oldConfig?.equals(config)) {
            return oldConfigID as ServerConfigID;
        }

        ServerInstanceConfig.RecordServerConfig.set(id, config);
        if (ServerInstanceConfig.RecordServerConfigNamed.has(name)) {
            LOGGER.warn(
                "警告！服务器配置“%s”（%s）仍在使用，但是将会被覆盖！",
                name,
                ServerInstanceConfig.RecordServerConfigNamed.get(name)
            );
        }
        ServerInstanceConfig.RecordServerConfigNamed.set(name, id);
        return id;
    }
    static removeNamedConfig(name: string): boolean {
        return ServerInstanceConfig.RecordServerConfigNamed.delete(name);
    }
    static removeConfig(id: ServerConfigID): boolean {
        return ServerInstanceConfig.RecordServerConfig.delete(id);
    }
    static hasConfig(id: ServerConfigID) {
        return ServerInstanceConfig.RecordServerConfig.has(id);
    }
    static hasNamedConfig(name: string) {
        return ServerInstanceConfig.RecordServerConfigNamed.has(name);
    }
    static getConfigID(name: string) {
        return ServerInstanceConfig.RecordServerConfigNamed.get(name);
    }
    static getConfig(configId: ServerConfigID) {
        return ServerInstanceConfig.RecordServerConfig.get(configId);
    }
    static getNamedConfig(name: string) {
        return ServerInstanceConfig.RecordServerConfig.get(ServerInstanceConfig.RecordServerConfigNamed.get(name) as string);
    }
    /**
     * 记录了服务器配置名对应的服务器配置
     */
    static RecordServerConfigNamed: Map<string, ServerConfigID> = new Map();
    static RecordServerConfig: Map<ServerConfigID, ServerInstanceConfig> = new Map();
}

class ServerInstance {
    #logger: log4js.Logger;
    #id: ServerInstanceID;
    #config: ServerInstanceConfig;
    #serverProcess: child_process.ChildProcess;
    #isRunning = true;

    get id() {
        return this.#id;
    }
    get config() {
        return this.#config;
    }
    get logger() {
        return this.#logger;
    }
    /**
     * 服务器实例的进程
     */
    get serverProcess() {
        return this.#serverProcess;
    }
    /**
     * 服务器进程是否正在运行
     */
    get isRunning() {
        return this.#isRunning;
    }

    constructor(id: ServerInstanceID, config: ServerInstanceConfig) {
        this.#id = id;
        this.#config = config;
        this.#logger = log4js.getLogger(config.name);
    }

    async #runStopCommand(status: { isExited: boolean }) {
        await 1; //break
        if (!status.isExited)
            for (const stopCmd of this.config.stopCommands) {
                if (stopCmd.type === "command" && stopCmd.value != undefined) {
                    this.sendCommand(stopCmd.value as string);
                } else if (stopCmd.type === "signal") {
                    this.serverProcess.kill(stopCmd.value as NodeJS.Signals);
                } else if (stopCmd.type === "kill") {
                    this.serverProcess.kill("SIGKILL");
                } else {
                    this.serverProcess.kill("SIGINT");
                    await timeWait(stopCmd.timeoutMs ?? 1500);
                    if (status.isExited) {
                        break;
                    } else {
                        this.serverProcess.kill("SIGKILL");
                    }
                }
                await Promise.any([
                    timeWait(stopCmd.timeoutMs ?? 1500),
                    new Promise<void>(resolve => {
                        this.serverProcess.on("exit", () => {
                            resolve();
                        });
                    })
                ]);
                if (status.isExited) {
                    break;
                }
            }

    }
    async stop(forceStop = false): Promise<boolean> {
        if (!this.isRunning) {
            return false;
        }
        const status = { isExited: false };
        await new Promise<void>(resolve => {
            this.serverProcess.on("exit", () => {
                resolve();
                status.isExited = true;
            });

            if (forceStop) {
                this.#serverProcess.kill("SIGKILL");
            } else {
                this.#runStopCommand(status);
            }
        });
        return true;
    }
    async forceStop(): Promise<boolean> {
        return this.stop(true);
    }

    sendCommand(cmd: string): boolean {
        if (this.config.stdin !== "use") {
            return false;
        }
        return this.serverProcess.stdin?.write(cmd + "\n") ?? false;
    }
    /**
     * 将已存在的进程作为服务器进程
     * @param name 
     * @param process 
     */
    static async asServerInstance(name: string, config: ServerInstanceConfig, serverProcess: child_process.ChildProcess): Promise<ServerInstance | null> {
        const id = createID();
        const { params, cwd, execOption, isMultiple, stdin, stdout } = config;
        const server = new ServerInstance(id, config);
        server.#serverProcess = serverProcess;
        if (serverProcess.killed || serverProcess.exitCode != null) {
            // 所以为什么要这样检测
            server.#isRunning = false;
        } else if (serverProcess.pid == undefined) {
            server.#isRunning = false;
            serverProcess.on("spawn", () => {
                server.#onCreate();
            });
        } else {
            server.#isRunning = true;
            server.#onCreate();
        }
        ServerInstance.RecordServerRunning.set(server.id, server);
        return server;
    }
    /**
     * 根据服务器配置创建进程
     */
    static async createServerInstance(
        name: string,
        config: ServerInstanceConfig
    ): Promise<ServerInstance | null> {
        const id = createID();
        const { params, cwd, execOption, isMultiple, stdin, stdout } = config;
        const server = new ServerInstance(id, config);
        const stdioOption: IOType[] = [];
        switch (stdin) {
            case "ignore":
                stdioOption[0] = "ignore";
                break;
            case "use":
                stdioOption[0] = "pipe";
                break;
            default:
                stdioOption[0] = "pipe";
        }
        switch (stdout) {
            case "ignore":
                stdioOption[1] = stdioOption[2] = "ignore";
                break;
            case "pass":
                stdioOption[1] = stdioOption[2] = "inherit";
                break;
            case "use":
                stdioOption[1] = stdioOption[2] = "pipe";
                LOGGER.warn("stdout(use) have not been implemented");
                break;
            default:
                stdioOption[1] = stdioOption[2] = "pipe";
        }
        try {
            server.#serverProcess = child_process.spawn(params[0], params.slice(1), Object.assign({
                cwd,
                stdio: stdioOption,
            }, execOption));
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(
                    () => reject("spawn timeout"),
                    3 * 1000
                );
                const oneTimeErrorListener = (err: any) => {
                    reject(err);
                };
                const errorListener = server.serverProcess.once("error", oneTimeErrorListener);
                server.serverProcess.once("spawn", () => {
                    clearTimeout(timeout);
                    server.serverProcess.off("error", oneTimeErrorListener);
                    resolve();
                });
            });
            server.serverProcess.on("error", (err) => {
                log4js.getLogger(name).error(err);
            });
        } catch (e) {
            log4js.getLogger(name).error("启动服务器进程失败:", e);
            return null;
        }
        ServerInstance.RecordServerRunning.set(server.id, server);
        server.#onCreate();
        return server;
    }
    #onCreate() {
        this.serverProcess.once("exit", (code, signal) => this.#onExit(code, signal));
    }
    #onExit(code: number | null, signal: NodeJS.Signals | null) {
        this.logger.trace("process quit: %s, status: %s", this.serverProcess.pid, code ?? signal);
        ServerInstance.RecordServerRunning.delete(this.id);
        this.#isRunning = false;
    }
    /**
     * 正在运行的服务器进程
     */
    static RecordServerRunning = new Map<ServerInstanceID, ServerInstance>();
}

type ServerConfig = {
    instanceConfig: ServerInstanceConfig
    autoRestart: boolean
    name: string
}

class Server {
    readonly id: ServerRunID = createID(5);
    #instance: ServerInstance | null = null;
    #config: ServerConfig;
    get instance(): ServerInstance | null {
        return this.#instance;
    }
    get config() {
        return this.#config;
    }
    get latestInstanceConfig() {
        return this.#latestInstanceConfig ?? this.config.instanceConfig;
    }
    /**
     * 服务器的名字，对于Multiple服务器，不同的服务器会有不同的后缀
     */
    get name() {
        let name = this.config.name;
        if (this.config.instanceConfig.isMultiple) {
            name += `@${this.id}`;
        }
        return name;
    }
    #logger: Logger;

    constructor(config: ServerConfig) {
        this.#config = config;
        this.#logger = log4js.getLogger(this.name);
    }
    #restartLock = new Lock(true);
    #crashRestartTimeLimit = new RestartLimit({ maxTimes: 5, interval: 10 * 60 * 1000 });
    #isActive: boolean = false;

    /**
     * 检查服务器是否仍在活跃
     */
    isActive(): boolean {
        return this.#isActive;
    }
    /**
     * 检查服务器进程是否正在运行
     */
    isRunning(): boolean {
        return this.#instance?.isRunning ?? false;
    }
    #latestInstanceConfig: ServerInstanceConfig | null = null;
    /**
     * 获取最新的配置
     */
    updateInstanceConfig(config: ServerInstanceConfig | null = this.#latestInstanceConfig) {
        if (config == null) {
            return;
        }
        // 服务器配置未改变，无需处理
        if (this.#config.instanceConfig.equals(config)) {
            return;
        }
        // 服务器未在运行，直接替换配置
        if (!this.isRunning()) {
            this.config.instanceConfig = config;
            this.#logger.info("服务器配置已更新");
        }
        // 服务器配置已更新，但是目前服务器正在运行
        // 更新服务器配置
        this.#latestInstanceConfig = config;
    }
    async #onExit(instance: ServerInstance, code: null | number, signal: null | NodeJS.Signals) {
        if (this.#instance === instance) {
            this.#instance = null;
        }
        const processName = String(instance.serverProcess.pid ?? "");
        this.#logger.info("服务器进程%s已退出，%s：%s", processName, code == null ? "信号" : "状态", code ?? signal);
        if (this.config.autoRestart) {
            this.#doAutoRestart();
        } else {
            this.#isActive = false;
        }
    }
    async #doAutoRestart(unlock?: () => void) {
        if (this.#instance != null || !this.config.autoRestart) {
            return;
        }
        if (unlock == undefined) {
            unlock = await this.#restartLock.lock();
        }
        if (this.#crashRestartTimeLimit.exceed()) {
            this.#logger.warn("服务器崩溃自动重启的次数过多，稍后再尝试重新启动");
            this.#timeoutIdCrashRestart = setTimeout(() => {
                this.#doAutoRestart(unlock);
            }, this.#crashRestartTimeLimit.interval);
            return;
        }
        this.#logger.warn("服务器异常退出，尝试重新启动");
        await this._startProcess();
        unlock();
    }
    /**
     * 启动服务器
     */
    async start(): Promise<boolean> {
        if (this.isRunning()) {
            return false;
        }
        this.#isActive = true;
        const unlock = await this.#restartLock.lock();
        this.updateInstanceConfig();
        const isSucceed = await this._startProcess();
        unlock();
        if (!isSucceed) {
            if (this.config.autoRestart) {
                this.#doAutoRestart();
            } else {
                this.#isActive = false;
            }
        }
        return isSucceed;
    }
    #timeoutIdCrashRestart: NodeJS.Timeout | null = null;
    /**
     * 关闭服务器
     */
    async stop(forceStop = false): Promise<boolean> {
        if (forceStop) {
            if (this.#timeoutIdCrashRestart != null) {
                clearTimeout(this.#timeoutIdCrashRestart);
                this.#timeoutIdCrashRestart = null;
            }
            this.#restartLock.unlock();
        }
        const unlock = await this.#restartLock.lock();
        let result = await this._stopProcess(forceStop);
        unlock();
        if (forceStop) {
            this.#isActive = false;
            result = true;
        }
        return result;
    }
    async forceStop() {
        return this.stop(true);
    }
    /**
     * 运行新的服务器进程
     */
    async _startProcess() {
        const instance = await ServerInstance.createServerInstance(this.name, this.config.instanceConfig);
        if (instance == null) {
            return false;
        }
        this.#logger.info("已创建新的服务器进程，PID：%s", instance.serverProcess.pid);
        this.#instance = instance;
        instance.serverProcess.on("exit", (code, signal) => {
            this.#onExit(instance, code, signal);
        });
        return true;
    }
    /**
     * 关闭服务器进程
     */
    async _stopProcess(forceStop = false): Promise<boolean> {
        let result: boolean = false;
        if (this.instance != null) {
            result = await this.instance.stop(forceStop);
            await 1; //break
        }
        return result;
    }
    /**
     * 重新启动服务器
     */
    async restart() {
        const handle = await this.#restartLock.lock();
        await this._stopProcess();
        await this._startProcess();
        handle();
    }
}

const Commands: Record<string, (args: string[], raw: string) => void> = {
    "+debug": () => {
        LOGGER.info("ServerInstance", ServerInstance);
        LOGGER.info("ServerInstanceConfig", ServerInstanceConfig);
        LOGGER.info("Main", Main.Instance);
    },
    "+start": (args, raw) => {
        Main.Instance.execAction({
            action: "server-start",
            server: raw
        });
    },
    "+forceStop": (args, raw) => {
        Main.Instance.execAction({
            action: "server-stop",
            server: raw,
            forceStop: true
        });
    },
    "+stop": (args, raw) => {
        Main.Instance.execAction({
            action: "server-stop",
            server: raw,
            forceStop: false
        });
    },
    "+send": (args, raw) => {
        const { arg: serverName, subcommand: command } = firstArg(raw) ?? {};
        if (serverName == null || command == null) {
            console.log("请输入正确的命令格式：+send <服务器名称> <命令>");
            return;
        }
        const commandClean = command.trim();
        DEBUG.info("即将向服务器 %s 发送命令：%s", serverName, commandClean);
        Main.Instance.sendServerCommand(serverName, commandClean);
    },
    "stop": () => {
        Main.Instance.stopScript();
    },
    "+restart": (args, raw) => {
        Main.Instance.execAction({
            action: "server-restart",
            server: raw
        });
    },
    "+reload": () => {
        Main.Instance.reload();
    },
    "+output": (args, raw) => {
        const output = args[0];
        if (output != null) {
            Main.Instance.setOutput(output);
        } else {
            console.log("当前命令输出为", Main.Instance.commandOutput);
        }
    },
    "+ps": () => {
        const allServers = [...Main.Instance.serverManager.RecordServers.values()];
        console.log("已经加载了下列服务：", allServers.map(server => server.name).join(" "));
        console.log("正在运行下列服务：", allServers.filter(server => server.isRunning()).map(server => server.name).join(" "));
    },
    "+status": () => {
        const allServers = [...Main.Instance.serverManager.RecordServers.values()];
        const runningServers = allServers.filter(server => server.isRunning());
        const activeServers = allServers.filter(server => server.isActive());
        const inactiveServers = allServers.filter(server => !server.isActive());
        const outdateServers = allServers.filter(server => !server.latestInstanceConfig.equals(server.config));

        const serverListTextLines = ["Server Status Config"];
        for (const server of allServers.toSorted((a, b) => a.name < b.name ? 1 : a.name === b.name ? 0 : -1)) {
            const status = server.isRunning() ? "running" : server.isActive() ? "active" : "stopped";
            const configStatus = server.config.instanceConfig.equals(server.latestInstanceConfig) ? "normal" : "outdated";
            serverListTextLines.push(`${server.name} ${status} ${configStatus}`);
        }

        console.log("当前状态：已运行%s，加载了%s个配置，已添加%s个计划任务"
            + EOL + "当前命令输出：%s"
            + EOL + "服务列表如下："
            + EOL + "%s"
            + EOL + "",
            getUptimeText(),
            ServerInstanceConfig.RecordServerConfig.size,
            Main.Instance.ListSchedules.size,
            Main.Instance.commandOutput ?? "<未定义>",
            serverListTextLines.join(EOL)
        );
    },
};

class ServerManager {
    ListLoadedServers = new Set<Server>();
    RecordServers = new Map<string, Server>();
    main: Main;
    get logger() {
        return this.main.logger;
    }
    constructor(main: Main) {
        this.main = main;
    }
    async stopAllServer() {
        this.logger.info("正在停止所有服务器");
        for (const serverName of this.main.autoStarts) {
            await this.stopServer(serverName);
        }
        for (const server of this.RecordServers.values()) {
            if (server.isRunning()) {
                await this.stopServer(server.name);
            }
        }
    }
    async sendSignalToServer(serverName: string, signal: NodeJS.Signals | number, serverIndex?: number) {
        const serverConfig = this.findRelaventInstanceConfig(serverName) as ServerInstanceConfig;
        const allServers = this.findServers(serverName);
        if (allServers.length > 1 && serverIndex == undefined) {
            this.logger.info("服务器 %s 有多个实例，将会向所有实例发送信号", serverName);
        }
        if (serverIndex == undefined) {
            for (const server of allServers) {
                if (server.isRunning()) {
                    server.instance?.serverProcess.kill(signal);
                }
            }
        } else {
            const server = allServers[serverIndex];
            if (server == undefined) {
                this.logger.error("未找到服务器 %s 的第 %s 个实例", serverName, serverIndex + 1);
            } else {
                if (server.isRunning()) {
                    server.instance?.serverProcess.kill(signal);
                }
            }
        }
    }
    findRelaventInstanceConfig(serverName: string): ServerInstanceConfig | undefined {
        let serverConfig: ServerInstanceConfig | undefined = ServerInstanceConfig.getNamedConfig(serverName);
        if (serverConfig == undefined) {
            const server = this.RecordServers.get(serverName);
            if (server != undefined) {
                serverConfig = server.latestInstanceConfig;
            }
        }
        return serverConfig;
    }
    /**
     * 获取所有与指定参数有关的服务器实例。
     * 
     * 如果设置`slientError`为`true`，在没有找到服务器时不会发生任何事情，只是返回空数组；
     * 如果未设置`slientError`，在没有找到服务器时会在日志中输出警告，并返回空数组；
     * 如果设置`slientError`为`false`，在没有找到服务器时会抛出错误。
     * 
     * @param serverName 与服务器关联的名字
     * @returns 返回与给定的名字关联的所有服务器
     * @throws 如果设置`slientError`为`false`并且没有找到任何服务器，则抛出TypeError以表示未能找到服务器。
     */
    findServers(serverName: string, slientError?: boolean): Server[] {
        let serverConfig: ServerInstanceConfig | undefined = ServerInstanceConfig.getNamedConfig(serverName);
        const allServers: Server[] = [];
        if (serverConfig != undefined) {
            for (const server of this.RecordServers.values()) {
                if (serverConfig.equals(server.latestInstanceConfig)) {
                    allServers.push(server);
                }
            }
        } else {
            const server = this.RecordServers.get(serverName);
            if (server != undefined) {
                allServers.push(server);
                serverConfig = server.latestInstanceConfig;
            }
        }
        if (serverConfig == undefined && slientError == undefined) {
            this.logger.warn("无法找到服务器 %s：", serverName, new TypeError("no config match to " + serverName));
        } else if (serverConfig == undefined && slientError === false) {
            throw new TypeError("no config match to " + serverName);
        }
        return allServers;
    }
    async stopServer(serverName: string, force: boolean = false, serverIndex?: number) {
        const allServers = this.findServers(serverName);
        const serverConfig = this.findRelaventInstanceConfig(serverName) as ServerInstanceConfig;

        if (allServers.length > 1 && serverIndex == undefined) {
            this.logger.info("服务器 %s 有多个实例，将会停止所有实例", serverName);
        } else if (allServers.length === 1){
            this.logger.info("正在关闭服务器 %s", serverName)
        }
        if (serverIndex == undefined) {
            for (const server of allServers) {
                if (force) {
                    this.logger.info("正在强行停止服务器 %s", server.name);
                } else {
                    this.logger.info("正在关闭服务器 %s", server.name);
                }
                await server.stop(force);
            }
        } else {
            const server = allServers[serverIndex];
            if (server == undefined) {
                this.logger.error("未找到服务器 %s 的第 %s 个实例", serverName, serverIndex + 1);
            } else {
                if (force) {
                    this.logger.info("正在强行停止服务器 %s", server.name);
                } else {
                    this.logger.info("正在关闭服务器 %s", server.name);
                }
                await server.stop(force);
            }
        }
        if (allServers.length > 1 && serverConfig.isMultiple) {
            await 1; // break
            for (const server of allServers.slice(1)) {
                if (server.isActive()) {
                    continue;
                }
                this.RecordServers.delete(server.name);
                this.logger.info("已从配置列表中移除服务器 %s", server.name);
            }
        }
    }
    async restartServer(serverName: string, serverIndex?: number): Promise<void> {
        const serverConfig = this.findRelaventInstanceConfig(serverName) as ServerInstanceConfig;
        const allServers = this.findServers(serverName);
        if (allServers.length > 1 && serverIndex == undefined) {
            this.logger.info("服务器 %s 有多个实例，将会重启所有实例", serverName);
        }
        if (serverIndex == undefined) {
            for (const server of allServers) {
                await server.restart();
            }
        } else {
            const server = allServers[serverIndex];
            if (server == undefined) {
                this.logger.error("未找到服务器 %s 的第 %s 个实例", serverName, serverIndex + 1);
            } else {
                await server.restart();
            }
        }
    }
    async startServer(serverName: string, serverIndex?: number): Promise<boolean> {
        const serverConfig = ServerInstanceConfig.getNamedConfig(serverName);
        if (serverConfig == undefined) {
            this.logger.error("指定的服务器不存在：%s", serverName);
            return false;
        }
        const allServers = [...this.RecordServers.values()].filter(server => serverConfig.equals(server.latestInstanceConfig));
        if (!serverConfig.isMultiple && allServers.length > 1) {
            this.logger.error("指定的服务器未启用多实例，但是找到了多条服务器信息：%s", serverName);
            return false;
        } else if (!serverConfig.isMultiple && allServers.length === 1 && allServers[0].isRunning()) {
            this.logger.warn("服务器 %s 已在运行中，不会启动新的实例", serverName);
            return false;
        } else if (!serverConfig.isMultiple && allServers.length === 0) {
            this.logger.error("服务器配置未初始化: " + serverName);
            return false;
        }
        let firstInactiveServer: Server | undefined = allServers.find(server => !server.isActive());
        if (firstInactiveServer == undefined) {
            if (serverConfig.isMultiple) {
                this.logger.info("为 %s 初始化新的服务器", serverName);
                const newServer: Server = this.createServerCopy(serverName);
                firstInactiveServer = newServer;
            } else {
                firstInactiveServer = allServers[0];
            }
        }
        if (firstInactiveServer.isActive()) {
            this.logger.error("无法启动服务器 %s，服务器正忙于特定操作");
            return false;
        } else {
            return await firstInactiveServer.start();
        }
    }
    createServerCopy(name: string): Server {
        const server = [...this.RecordServers.values()].find(s => s.config.name === name);
        if (server == undefined) {
            throw new TypeError(`Server ${name} not found`);
        }
        const { latestInstanceConfig: instanceConfig, config: serverConfig } = server;
        const serverInstanceConfig = server.latestInstanceConfig;
        if (!serverInstanceConfig.isMultiple) {
            throw new TypeError(`Server ${name} is not a multiple server`);
        }
        const serverCopy = new Server(Object.assign({}, serverConfig, { instanceConfig }));

        this.RecordServers.set(serverCopy.name, serverCopy);
        if (this.ListLoadedServers.has(server)) {
            this.ListLoadedServers.add(serverCopy);
        }

        return serverCopy;
    }
}

class Main {
    logger = LOGGER;
    static Instance: Main = null as any;
    serverManager: ServerManager;
    ListSchedules = new Set<ScheduledTask>();
    commandOutput: string | null = null;
    defaultCommandOutput: string | null = null;
    constructor() {
        this.serverManager = new ServerManager(this);
    }

    autoStarts: string[] = [];
    shell: string[] = [];
    #readline: readline.ReadLine;

    nextCommand(cmd: string) {
        const p = firstArg(cmd);
        const p0 = p?.arg ?? "+status";
        const s = p?.subcommand.trim() ?? "";
        const args: string[] = [];
        let ap = firstArg(s);
        while (ap?.arg != null) {
            args.push(ap.arg);
            ap = firstArg(ap.subcommand);
        }
        if (Commands[p0] != null) {
            Commands[p0](args, s.trim());
        } else {
            this.logger.error("无法识别的命令：", cmd);
        }
        if (this.isOutputAvailable()) {
            this.sendServerCommand(this.commandOutput as string, cmd);
        } else {
            this.logger.warn("命令输出不可用");
            if (this.defaultCommandOutput != null && this.isOutputAvailable(this.defaultCommandOutput)) {
                this.logger.info("默认输出已切换到服务器 %s", this.defaultCommandOutput);
            }
        }
    }
    setOutput(serverName: string, chooseFirst: boolean = false) {
        const servers = this.serverManager.findServers(serverName);
        if (servers.length !== 1 && !chooseFirst) {
            this.logger.error("服务器 %s 有 %d 个实例，无法确定要发送命令的服务器", serverName, servers.length);
            return;
        }
        const server = servers[0];
        if (server.config.instanceConfig.stdin !== "use") {
            this.logger.error("服务器 %s 未配置 stdin 为 use，无法发送命令", server.name);
            return false;
        }
        this.commandOutput = server.name;
        this.logger.info("已将命令输出切换到服务器 %s", server.name);
    }
    isOutputAvailable(output = this.commandOutput): boolean {
        if (output == null) {
            return false;
        }
        const servers = this.serverManager.findServers(output, true);
        if (servers.length !== 1) {
            return false;
        }
        const server = servers[0];
        if (server.config.instanceConfig.stdin !== "use") {
            return false;
        }
        return server.isRunning();
    }
    async startScript() {
        this.logger.info("启动程序中");
        this.#readline = readline.createInterface({
            input: process.stdin,
            output: process.stderr,
        });
        this.#readline.on("line", this.nextCommand.bind(this));

        await this.reload(configFile);
        await this.startAutoStartsServers();
        this.logger.info("程序已启动");
    }
    async stopScript() {
        this.logger.info("正在结束运行");
        this.#readline.close();
        this.logger.info("关闭服务器中")
        await this.serverManager.stopAllServer();
        for (const serverInstance of ServerInstance.RecordServerRunning.values()) {
            await serverInstance.forceStop();
        }
        this.logger.info("程序已结束");
        process.exit(0);
    }

    async reload(file: string = configFile): Promise<boolean> {
        this.logger.info("正在加载配置文件 %s", file);
        try {
            const result = await this.#reload(file);
            if (result != null) {
                console.log("加载了%s个服务器配置，已添加%s个计划任务",
                    result.serverCount,
                    result.scheduleCount
                );
                return true;
            } else {
                return false;
            }
        } catch (e) {
            this.logger.error("配置文件加载失败", e);
            return false;
        }
    }
    
    async #reload(file: string = configFile): Promise<{ serverCount: number, scheduleCount: number } | null> {
        const starterConfig = await readConfigFile(file);
        if (starterConfig == null) {
            this.logger.error("cannot reload the config file");
            return null;
        }
        const result = { serverCount: 0, scheduleCount: 0 };
        DEBUG.debug("current config:", starterConfig);

        // load servers to config object
        for (const iname in starterConfig.servers) {
            const starterInstanceConfig = starterConfig.servers[iname];
            const configId = ServerInstanceConfig.addServerConfig(iname, starterInstanceConfig);
            const config = ServerInstanceConfig.getConfig(configId) as ServerInstanceConfig;
            // 需要检查multiple服务器
            if (!this.serverManager.RecordServers.has(iname) && undefined == [...this.serverManager.RecordServers.values()].find(_ => _.config.name === iname)) {
                // 新的服务器配置，创建新的Server
                const server = new Server({
                    instanceConfig: config,
                    autoRestart: false,
                    name: config.name,
                });

                this.serverManager.RecordServers.set(server.name, server);
                this.serverManager.ListLoadedServers.add(server);
            }
            result.serverCount++;
        }

        // check deleted server config
        for (const [name, server] of this.serverManager.RecordServers) {
            // 为了兼容多服务器的情况（isMultiple），应该读取server.config.name，而不是server.name
            const loadedServerConfig = ServerInstanceConfig.getNamedConfig(server.config.name);
            // 服务器配置被删除，所以同步移除服务器
            if (loadedServerConfig == undefined) {

                this.serverManager.ListLoadedServers.delete(server);

                continue;
            }
            server.updateInstanceConfig(loadedServerConfig);
        }

        // apply autoRestarts
        if (starterConfig.autoRestarts != undefined)
        for (const [name, server] of this.serverManager.RecordServers) {

            if (!(this.serverManager.ListLoadedServers.has(server)) && !server.isActive()) {
                this.serverManager.RecordServers.delete(name);
            }

            if (starterConfig.autoRestarts.includes(server.config.name)) {
                server.config.autoRestart = true;
            } else {
                server.config.autoRestart = false;
            }
        }

        if (starterConfig.shell != undefined)
            this.shell = typeof starterConfig.shell === "string" ? [starterConfig.shell] : starterConfig.shell;
        else
            this.shell = ["/bin/bash"];

        this.autoStarts = starterConfig.autoStarts ?? [];
        this.defaultCommandOutput = starterConfig.defaultCommandOutputServer ?? null;

        // clean old schedules
        this.ListSchedules.forEach(task => task.stop());
        this.ListSchedules.clear();

        // load shcedule config
        if (starterConfig.schedules != undefined)
        for (const schedule of starterConfig.schedules) {
            const task = cron.schedule(schedule.cron, () => {
                this.runSchedule(schedule);
            });
            this.ListSchedules.add(task);
            result.scheduleCount++;
        }

        if (!this.isOutputAvailable() && this.defaultCommandOutput != null) {
            this.setOutput(this.defaultCommandOutput);
        }

        DEBUG.debug(this);
        return result;
    }

    async startAutoStartsServers() {
        if (this.autoStarts.length === 0) {
            this.logger.info("没有需要自启动的服务器");
            return;
        }
        loopStarts:
        for (const serverName of this.autoStarts) {
            const allServers = this.serverManager.findServers(serverName);
            for (const server of allServers) {
                if (server.isRunning()) {
                    this.logger.warn("自动启动服务器失败：服务器已在运行：", server.name);
                    continue;
                }
                if (await server.start()) {
                    await timeWait(1000);
                } else {
                    this.logger.error("自动启动服务器失败：", serverName);
                    continue loopStarts;
                }
            }
        }
    }
    async runSchedule(task: StarterSchedule) {
        this.logger.debug("正在运行任务：%s", JSON.stringify(task));
        try {
            await this.#execAction(task);
        } catch (e) {
            this.logger.error("在执行计划任务时出现错误：", e);
        }
    }
    async execAction(action: StarterAction) {
        this.logger.trace("执行操作：%s", JSON.stringify(action));
        try {
            await this.#execAction(action);
        } catch (e) {
            this.logger.error("在执行操作时出现错误：%s", JSON.stringify(action), e);
        }
    }

    async #execAction(action: StarterAction) {
        if (action.action === "cmd") {
            const cmdServerConfigName = `schedule$${createID(6)}`;
            const cmdServerConfigId = ServerInstanceConfig.addServerConfig(cmdServerConfigName, {
                params: [],
                stopCommands: [{ type: "mixed" }],
                stdin: "use",
                stdout: "pass",
                cwd: ".",
                isMultiple: false,
                "exec-option": null,
            });
            const cmdServerConfig = ServerInstanceConfig.getConfig(cmdServerConfigId) as ServerInstanceConfig;
            const serverProcess = child_process.spawn(action.value, [], {
                cwd: action.cwd ?? baseDir,
                timeout: action.timeout,
                stdio: ["pipe", "inherit", "inherit"],
                shell: true,
            });
            const serverInstance = await ServerInstance.asServerInstance(cmdServerConfigName, cmdServerConfig, serverProcess);
            await new Promise<void>((resolve, reject) => {
                serverProcess.on("error", (err) => {
                    reject(err);
                    serverInstance?.forceStop();
                });
                serverProcess.on("spawn", () => {
                    serverInstance?.logger.info("进程已启动");
                });
                serverProcess.on('exit', () => {
                    resolve();
                    ServerInstanceConfig.removeConfig(cmdServerConfigId);
                    ServerInstanceConfig.removeNamedConfig(cmdServerConfigName);
                });
            });
        } else if (action.action === "server-start") {
            this.serverManager.startServer(action.server, action.serverIndex);
        } else if (action.action === "server-stop") {
            this.serverManager.stopServer(action.server, action.forceStop, action.serverIndex);
        } else if (action.action === "server-restart") {
            this.serverManager.restartServer(action.server, action.serverIndex);
        } else if (action.action === "server-kill") {
            this.serverManager.sendSignalToServer(action.server, action.value, action.serverIndex);
        } else if (action.action === "server-command") {
            this.sendServerCommand(action.server, action.server, action.serverIndex);
        } else if (action.action === "stop-all-server") {
            this.serverManager.stopAllServer();
        } else if (action.action === "start-auto-starts-server") {
            await this.startAutoStartsServers();
        }
    }
    sendServerCommand(serverName: string, command: string, serverIndex?: number): boolean {
        const serverConfig = this.serverManager.findRelaventInstanceConfig(serverName) as ServerInstanceConfig;
        const allServers = this.serverManager.findServers(serverName);
        if (allServers.length > 1 && serverIndex == undefined) {
            this.logger.error("服务器 %s 有 %d 个实例，无法确定要发送命令的服务器", serverName, allServers.length);
            return false;
        }
        let server: Server | undefined;
        if (serverIndex == undefined) {
            server = allServers[0];
        } else {
            server = allServers[serverIndex];
            if (server == undefined) {
                this.logger.error("未找到服务器 %s 的第 %s 个实例", serverName, serverIndex + 1);
                return false;
            }
        }
        if (server.config.instanceConfig.stdin !== "use") {
            this.logger.error("服务器 %s 未配置 stdin 为 use，无法发送命令", server.name);
            return false;
        }
        if (!server.isRunning()) {
            this.logger.error("服务器 %s 未运行，无法发送命令", serverName);
            return false;
        }
        const instance = server.instance as ServerInstance;
        return instance.sendCommand(command);
    }
    
}

Main.Instance = new Main();

class RestartLimit {
    record: number[] = [];
    maxTimes = 3;
    interval = 3 * 60 * 1000;
    next() {
        this.record.push(Date.now());
        return this.exceed();
    }
    constructor(option?: { maxTimes?: number; interval?: number }) {
        if (!option) return;
        if (option.maxTimes != null) {
            this.maxTimes = option.maxTimes;
        }
        if (option.interval != null) {
            this.interval = option.interval;
        }
    }
    exceed() {
        const now = Date.now();
        let { interval, maxTimes, record } = this;

        // 找到记录当中与当前时间的差距小于等于 interval 的数据的位置
        // 然后更新数据起点
        let minTime = now - interval;
        let cutIndex = 0;
        for (let i = 0; i < record.length; i++) {
            cutIndex = i + 1;
            const time = record[i];
            if (time >= minTime) {
                cutIndex -= 1;
                break;
            }
        }

        if (cutIndex !== 0) {
            record = record.slice(cutIndex);
            this.record = record;
        }

        return record.length > maxTimes;
    }
}

class Lock {
    #unlock: null | (() => void);
    #unlockable: boolean;
    constructor(unlockable = false) {
        this.#unlockable = unlockable;
    }
    unlock(): void {
        if (!this.#unlockable) {
            throw new ReferenceError("cannot unlock a non-unlockable lock");
        }
        this.#unlock?.();
    }
    /**
     * 尝试锁定
     * @returns 返回的函数用于解锁
     */
    lock(): Promise<() => boolean>;
    /**
     * 尝试在指定的时间内锁定，否则抛出错误
     *
     * @returns 返回的函数用于解锁
     * @throws 在达到指定的时间后仍未能够获取锁，则抛出错误
     */
    lock(timeousMs: number): Promise<() => boolean>;
    async lock(timeousMs?: number) {
        if (this.#isLocked) {
            await new Promise<void>((resolve, reject) => {
                let timeoutId = null;
                if (timeousMs != undefined) {
                    timeoutId = setTimeout(() => {
                        reject(new Error("timeout to waiting lock"));
                    }, timeousMs);
                }
                this.#handles.push(() => {
                    resolve();
                    if (timeoutId != null) {
                        clearTimeout(timeoutId);
                    }
                });
            });
        }

        this.#isLocked = true;
        let isUnlocked = false;
        const unlock = () => {
            if (isUnlocked) {
                return false;
            }
            isUnlocked = true;
            this.#isLocked = false;
            const nextLock = this.#handles.shift();
            if (nextLock != null) {
                setImmediate(nextLock);
            }
            return true;
        };
        this.#unlock = unlock;
        return unlock;
    }
    #isLocked = false;
    #handles: (() => void)[] = [];
}

main();
