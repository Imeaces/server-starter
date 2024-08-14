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

const LOGGER = log4js.getLogger("server-starter");

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
            level: "debug",
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
        } else {
            console.error("unknown arg: %s", arg);
            process.exit(2);
            throw new Error();
        }
    }
    LOGGER.info("正在启动程序，baseDir: %s，configFile：%s", baseDir, configFile);
    new Main().startScript();
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
type StarterAction = StarterSignalServerAction | StarterStartServerAction | StarterStopServerAction | StarterRestartServerAction | StarterCmdAction;
type StarterCmdAction = {
    action: "cmd"
    value: string
    timeout?: number
    cwd?: string
};
type StarterRestartServerAction = {
    action: "server-restart"
    value: string
}
type StarterStartServerAction = {
    action: "server-start"
    value: string
}
type StarterStopServerAction = {
    action: "server-stop"
    value: string
    forceStop?: boolean
}
type StarterSignalServerAction = {
    action: "server-kill"
    value: string
    signal: NodeJS.Signals | number
}

type StarterServerConfig = {
    cwd?: string
    "exec-option"?: any
    params: string[],
    isMultiple?: boolean
    stdout?: "use" | "pass" | "ignore"
    stdin?: "use" | "ignore"
    stopCommand?: ServerInstanceConfigStopCommand[]
};

type ServerStarterConfig = {
    schedules: StarterSchedule[];
    servers: Record<string, StarterServerConfig>;
    autoStarts?: string[];
    autoRestarts?: string[];
    shell?: string | string[]
};

async function readConfigFile(file: string = configFile): Promise<ServerStarterConfig | null> {
    try {
        const data = await fs.readFile(file, "utf8");
        const config = yaml.load(file) as any;
        const { schedules, servers, autoStarts, autoRestarts, shell } = config;
        return { schedules, servers, autoStarts, autoRestarts, shell };
    } catch (e) {
        LOGGER.error("无法加载配置：", e);
    }
    return null;
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
    "recoverMissedExecutions": true,
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
    #stopCommand: ServerInstanceConfigStopCommand[] = [];

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
        return false;
        return this.#isMultiple;
    }
    get stdout() {
        return this.#stdout;
    }
    get stdin() {
        return this.#stdin;
    }
    get stopCommand() {
        return this.#stopCommand;
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
            const { name, cwd, params, isMultiple, stdout, stdin, execOption, stopCommand } = this;
            myConfig = { name, cwd, params, isMultiple, stdout, stdin, execOption, stopCommand, };
        }
        {
            const { name, cwd, params, isMultiple, stdout, stdin, execOption, stopCommand } = o;
            yourConfig = { name, cwd, params, isMultiple, stdout, stdin, execOption, stopCommand, };
        }
        return lodash.isEqual(myConfig, yourConfig);
    }
    static addServerConfig(name: string, data: StarterServerConfig): ServerConfigID {
        const id = createID();
        const config = new ServerInstanceConfig();
        config.#name = name;
        config.#cwd = path.join(baseDir, data.cwd ?? ".");
        config.#params = data.params;
        config.#isMultiple = data.isMultiple === true ? true : false;
        config.#stdout = data.stdout ?? "use";
        config.#stdin = data.stdin ?? "use";
        config.#execOption = data["exec-option"];
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
            for (const stopCmd of this.config.stopCommand) {
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
                //TODO: implements stdout option: use
                LOGGER.warn("stdout(use) have not been implemented");
                break;
            default:
                stdioOption[1] = stdioOption[2] = "pipe";
        }
        server.#serverProcess = serverProcess;
        if (serverProcess.killed || serverProcess.exitCode != null) {
            // 所以为什么要这样检测
            server.#isRunning = false;
        } else if (serverProcess.pid == undefined) {
            server.#isRunning = false;
        } else {
            server.#isRunning = true;
        }
        ServerInstance.RecordServerRunning.set(server.id, server);
        server.#onCreate();
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
        if (!this.isRunning) {
            this.config.instanceConfig = config;
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
    async start() {
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
    }
    #timeoutIdCrashRestart: NodeJS.Timeout | null = null;
    /**
     * 关闭服务器
     */
    async stop(forceStop = false) {
        if (forceStop) {
            if (this.#timeoutIdCrashRestart != null) {
                clearTimeout(this.#timeoutIdCrashRestart);
                this.#timeoutIdCrashRestart = null;
            }
            this.#restartLock.unlock();
        }
        const unlock = await this.#restartLock.lock();
        await this._stopProcess(forceStop);
        unlock();
        if (forceStop) {
            this.#isActive = false;
        }
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
    async _stopProcess(forceStop = false) {
        if (this.instance != null) {
            await this.instance.stop(forceStop);
            await 1; //break
        }
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
    "+start": (args, raw) => {
        Main.Instance.execAction({
            action: "server-start",
            value: raw
        });
    },
    "+stop": (args, raw) => {
        let serverName: string;
        let forceStop: boolean = false;
        if (raw.lastIndexOf("false") + "false".length === raw.length) {
            forceStop = false;
            serverName = raw.substring(0, raw.lastIndexOf("false"));
        } else if (raw.lastIndexOf("true") + "true".length === raw.length) {
            forceStop = true;
            serverName = raw.substring(0, raw.lastIndexOf("true"));
        } else {
            serverName = raw;
        }
        Main.Instance.execAction({
            action: "server-stop",
            value: serverName,
            forceStop: forceStop
        });
    },
    "+restart": (args, raw) => {
        Main.Instance.execAction({
            action: "server-restart",
            value: raw
        });
    },
    "+reload": () => {
        Main.Instance.reload();
    },
    "+ps": () => {
        const allServers = [...Main.Instance.RecordServers.values()];
        console.log("已经加载了下列服务：", allServers.map(server => server.name).join(" "));
        console.log("正在运行下列服务：", allServers.filter(server => server.isRunning()).map(server => server.name).join(" "));
    },
    "+status": () => {
        const allServers = [...Main.Instance.RecordServers.values()];
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
            + EOL + "服务列表如下："
            + EOL + "%s"
            + EOL + "",
            getUptimeText(),
            ServerInstanceConfig.RecordServerConfig.size,
            Main.Instance.ListSchedules.size,
            serverListTextLines.join(EOL)
        );
    },
};

class Main {
    static Instance: Main = null as any;
    ListLoadedServers = new Set<Server>();
    RecordServers = new Map<string, Server>();
    ListSchedules = new Set<ScheduledTask>();
    #readline: readline.ReadLine;
    nextCommand(cmd: string) {
        
    }
    async startScript() {
        this.#readline = readline.createInterface({
            input: process.stdin,
            output: process.stderr,
        });
        this.#readline.on("line", this.nextCommand.bind(this));

        await this.reload(configFile);
        if (this.autoStarts.length === 0) {
            LOGGER.info("没有需要自启动的服务器");
        }
        for (const a of this.autoStarts) {
            await this.startServer(a);
        }
    }
    //TODO: 添加配置文件检查
    async reload(file: string = configFile): Promise<boolean> {
        LOGGER.info("正在加载配置文件 %s", file);
        const starterConfig = await readConfigFile(file);
        if (starterConfig == null) {
            LOGGER.error("cannot reload the config file");
            return false;
        }
        for (const iname in starterConfig.servers) {
            const starterInstanceConfig = starterConfig.servers[iname];
            const configId = ServerInstanceConfig.addServerConfig(iname, starterInstanceConfig);
            const config = ServerInstanceConfig.getConfig(configId) as ServerInstanceConfig;
            // 需要检查multiple服务器
            if (!this.RecordServers.has(iname) && undefined == [...this.RecordServers.values()].find(_ => _.config.name === iname)) {
                // 新的服务器配置，创建新的Server
                const server = new Server({
                    instanceConfig: config,
                    autoRestart: false,
                    name: config.name,
                });

                this.RecordServers.set(server.name, server);
                this.ListLoadedServers.add(server);
            }
        }
        for (const [name, server] of this.RecordServers) {
            // 为了兼容多服务器的情况（isMultiple），应该读取server.config.name，而不是server.name
            const loadedServerConfig = ServerInstanceConfig.getNamedConfig(server.config.name);
            // 服务器配置被删除，所以同步移除服务器
            if (loadedServerConfig == undefined) {

                this.ListLoadedServers.delete(server);

                continue;
            }
            server.updateInstanceConfig(loadedServerConfig);
        }
        for (const [name, server] of this.RecordServers) {

            if (!(this.ListLoadedServers.has(server)) && !server.isActive()) {
                this.RecordServers.delete(name);
            }

            if (starterConfig.autoRestarts?.includes(server.config.name)) {
                server.config.autoRestart = true;
            } else {
                server.config.autoRestart = false;
            }
        }
        if (typeof starterConfig.shell === "string") {
            this.shell = [starterConfig.shell];
        } else if (Array.isArray(starterConfig.shell)) {
            this.shell = starterConfig.shell;
        } else {
            this.shell = ["/bin/bash"];
        }
        this.autoStarts = starterConfig.autoStarts ?? [];
        this.ListSchedules.forEach(task => task.stop());
        this.ListSchedules.clear();
        for (const schedule of starterConfig.schedules) {
            const task = cron.schedule(schedule.cron, () => {
                this.runSchedule(schedule);
            });
            this.ListSchedules.add(task);
        }
        LOGGER.trace(this);
        return true;
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
    autoStarts: string[] = [];
    shell: string[] = [];
    async runSchedule(task: StarterSchedule) {
        LOGGER.debug("正在运行任务：%s", JSON.stringify(task));
        try {
            await this.#execAction(task);
        } catch (e) {
            LOGGER.error("在执行计划任务时出现错误：", e);
        }
    }
    async execAction(action: StarterAction) {
        LOGGER.trace("执行操作：%s", JSON.stringify(action));
        try {
            await this.execAction(action);
        } catch (e) {
            LOGGER.error("在执行操作时出现错误：%s", JSON.stringify(action), e);
        }
    }
    async #execAction(action: StarterAction) {
        if (action.action === "cmd") {
            const cmdServerConfigName = `schedule$${createID(6)}`;
            const cmdServerConfigId = ServerInstanceConfig.addServerConfig(cmdServerConfigName, {
                params: [],
                stopCommand: [{ type: "mixed" }],
                stdin: "use",
                stdout: "pass",
            });
            const cmdServerConfig = ServerInstanceConfig.getConfig(cmdServerConfigId) as ServerInstanceConfig;
            const serverProcess = child_process.spawn(action.value, [], {
                cwd: action.cwd ?? baseDir,
                timeout: action.timeout,
                stdio: ["pipe", "inherit", "inherit"],
            });
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
            const serverInstance = await ServerInstance.asServerInstance(cmdServerConfigName, cmdServerConfig, serverProcess);
        } else if (action.action === "server-start") {
            this.startServer(action.value);
        } else if (action.action === "server-stop") {
            this.stopServer(action.value, action.forceStop);
        } else if (action.action === "server-restart") {
            this.restartServer(action.value);
        } else if (action.action === "server-kill") {
            this.sendSignalToServer(action.value, action.signal);
        }
    }
    async sendSignalToServer(serverName: string, signal: NodeJS.Signals | number) {
        const serverConfig = ServerInstanceConfig.getNamedConfig(serverName);
        const allServers: Server[] = [];
        if (serverConfig != undefined) {
            for (const server of this.RecordServers.values()) {
                if (server.config.name == serverName) {
                    allServers.push(server);
                }
            }
        } else {
            const firstServer = this.RecordServers.get(serverName);
            if (firstServer != undefined) {
                allServers.push(firstServer);
            }
        }
        if (allServers.length === 0) {
            LOGGER.error("指定的服务器不存在：%s", serverName);
            return;
        }

        for (const server of allServers) {
            if (server.isRunning()) {
                server.instance?.serverProcess.kill(signal);
            }
        }
    }
    async stopServer(serverName: string, force: boolean = false) {
        let serverConfig: ServerInstanceConfig | undefined = ServerInstanceConfig.getNamedConfig(serverName);
        const allServers: Server[] = [];
        if (serverConfig != undefined) {
            for (const server of this.RecordServers.values()) {
                if (server.config.name == serverName) {
                    allServers.push(server);
                }
            }
        } else {
            const firstServer = this.RecordServers.get(serverName);
            if (firstServer != undefined) {
                allServers.push(firstServer);
                serverConfig = firstServer.config.instanceConfig;
            }
        }
        if (serverConfig == undefined) {
            LOGGER.error("指定的服务器不存在：%s", serverName);
            return;
        }

        for (const server of allServers) {
            await server.stop(force);
        }
        if (allServers.length > 1 && serverConfig.isMultiple) {
            for (const server of allServers.slice(1)) {
                this.RecordServers.delete(server.name);
            }
        }
    }
    async restartServer(serverName: string) {
        const serverConfig = ServerInstanceConfig.getNamedConfig(serverName);
        const allServers: Server[] = [];
        if (serverConfig != undefined) {
            for (const server of this.RecordServers.values()) {
                if (server.config.name === serverName) {
                    allServers.push(server);
                }
            }
        } else {
            const firstServer = this.RecordServers.get(serverName);
            if (firstServer != undefined) {
                allServers.push(firstServer);
            }
        }
        if (allServers.length === 0) {
            LOGGER.error("指定的服务器不存在：%s", serverName);
            return;
        }

        for (const server of allServers) {
            await server.restart();
        }
    }
    async startServer(serverName: string) {
        const serverConfig = ServerInstanceConfig.getNamedConfig(serverName);
        if (serverConfig == undefined) {
            LOGGER.error("指定的服务器不存在：%s", serverName);
            return;
        }
        const allServers = [...this.RecordServers.values()].filter(s => s.config.instanceConfig.isMultiple && s.config.name === serverName);
        if (!serverConfig.isMultiple) {
            if (allServers.length > 1) {
                LOGGER.error("指定的服务器未启用多实例，但是找到了多条服务器信息：%s", serverName);
            } else if (allServers.length === 1) {
                await allServers[0].start();
            } else {
                LOGGER.error("服务器配置未初始化: " + serverName);
            }
            return;
        }
        let firstInactiveServer: Server | undefined = allServers.find(server => !server.isActive);
        if (firstInactiveServer == undefined) {
            LOGGER.info("为 %s 初始化新的服务器", serverName);
            const newServer = this.createServerCopy(serverName);
            firstInactiveServer = newServer;
        }
        await firstInactiveServer.start();
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
