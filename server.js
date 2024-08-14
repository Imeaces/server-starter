#!/usr/bin/env node

const backupSchedule = "0 0 6 * * 4";
const imcServerDir = "./imeaces-origin_paper";

import readline from "node:readline";
import child_process from "node:child_process";
import cron from "node-cron";
import log4js from "log4js";
import path from "node:path";
import "./loggerConfig.js";

function main(){
   globalThis.Main = new Main();
   globalThis.Main.startScript();
}

class Main {
   lowLevelFunc = {
      runRegularShell,
   };
   lowlevelMethod = `
      startServer stopServer restartServer
      startMariadb stopMariadb restartMariadb
      startFrpc stopFrpc startSshProxy stopSshProxy
      stopAllProcess stopAll startAll fullRestartServer
      startCreateBackup newBackup
      stopScript
   `.trim().split(/\s+/);

   logger = log4js.getLogger("ServerStarter");
   callbacks = {
      serverStop: [],
      scriptStop: [],
      frpcStop: [],
   };
   serverProc = {
   };
   output = null;
   frpcStopped = false;
   serverStopped = false;
   flags = {};
   serverProcType = {
      mariadb: MariadbServerProc.bind(null, path.join(imcServerDir, ".mysql_data")),
      imcServer: ImcServerProc.bind(null, imcServerDir),
      sfServer: SelfServerProc.bind(null, "sf-server"),
      frpc: FrpcProc.bind(null, "frp/frpc_imeaces-origin.ini"),
      sshProxy: SshProxyProc,
      shell: ShellServerProc,
      backup: BackupServerProc,
      grakkitFetch: GrakkitGitFetchProc,
      grakkitAutoFetch: GrakkitGitFetchProc.bind(null, true),
      grakkitWatch: GrakkitTscBuildProc.bind(null, this),
      grakkitBuild: GrakkitTscBuildProc,
      httpProxy: HttpProxyProc,
      httpProxyAll: HttpProxyProc.bind(null, "proxyAll"),
      v2rayProxy: V2rayProxyProc,
   };
   autoRestartLimits = {
      default: new RestartLimit({
         interval: 10 * 60 * 1000,
         maxTimes: 10,
      }),
      imcServer: new RestartLimit({
         interval: 5 * 60 * 1000,
         maxTimes: 3,
      }),
      frpc: new RestartLimit({
         interval: 1 * 60 * 60 * 1000,
         maxTimes: 12,
      }),
      sshProxy: new RestartLimit({
         interval: 1 * 60 * 60 * 1000,
         maxTimes: 12,
      }),
   }
   #procStopStatus = {
      frpc: true,
      imcServer: true,
      sshProxy: true,
   };
   #serverRestartingStatus = {
      frpc: false,
      imcServer: false,
      sshProxy: false,
   };
   setProcEnd(type, bool){
      this.getProc(type, true);
      this.#procStopStatus[type] = bool;
   }
   isProcEnd(type){
      this.getProc(type, true);
      return this.#procStopStatus[type] === true;
   }
   isRestartLimit(type){
      if (this.autoRestartLimits[type] != null){
         return this.autoRestartLimits[type].next();
      }
      return this.autoRestartLimits.default.next();
   }
   setProcRestarting(type, bool){
      this.getProc(type, true);
      return this.#serverRestartingStatus[type] = bool;
   }
   isProcRestarting(type){
      this.getProc(type, true);
      return this.#serverRestartingStatus[type] === true;
   }

   registerAutoRestart(type, proc, restartMethod){
      proc.process.on("exit", () => {
         this.#tryAutoRestart(type, proc, restartMethod);
      });
   }

   async #tryAutoRestart(type, proc, method){
      if (this.isProcEnd(type) || this.isProcRestarting(type)){
         return;
      }
      try {
         this.setProcRestarting(type, true);
         this.logger.info("检测到属于 %s 的进程 %s 非正常退出，尝试重启", type, proc.toString());
         if (this.isRestartLimit(type)){
            this.logger.info("类型 %s 异常重启的尝试过多，等待一段时间后再尝试重启", type);
            for (let i = 0; i < 120; i++){
               await timeWait(1000);
               if (this.isProcEnd(type)){
                  break;
               }
            }
         }
         if (this.isProcEnd(type)){
            this.logger.info("%s 被手动设置为停止，不再自动重启", type);
            return;
         }
         this.logger.info("正在重新启动 %s", type);
         try {
            await method();
         } catch(e){
            this.logger.error("尝试重新启动 %s 时出现错误", e);
         }
         if (this.hasProc(type)){
            this.logger.info("%s 已重新启动", type);
         } else {
            this.logger.warn("%s 未能重启成功", type);
         }
      } finally {
         this.setProcRestarting(type, false);
      }
   }

   hasProc(serverType){
      return this.getProc(serverType, false) != null;
   }
   getProc(serverType, throwsOnNoType = true){
      if (this.serverProc[serverType] != null){
         return this.serverProc[serverType];
      }
      if (serverType in this.serverProcType){
         return this.serverProc[serverType] ?? null;
      } else if (throwsOnNoType){
         throw new TypeError("未知的服务类型: " + serverType);
      }
      return null;
   }
   async runProc(serverType, ServerProcType = null, ...args){
      if (ServerProcType == null){
         ServerProcType = this.serverProcType[serverType];
      }
      if (!this.hasProc(serverType)){
         const proc = new ServerProcType(...args);
         this.serverProc[serverType] = proc;
         const err = new Error("runProc " + serverType + " failed");
         const promise = new Promise((resolve, reject) => {
            const onSpawn = () => {
               onComplete();
               resolve();
            };
            const onSpawnError = (e) => {
               delete this.serverProc[serverType];
               onComplete();
               err.cause = e;
               reject(err);
            };
            const onComplete = () => {
               proc.process.off("spawn", onSpawn);
               proc.process.off("error", onSpawnError);
            };
            proc.process.on("spawn", onSpawn);
            proc.process.on("error", onSpawnError);
         });
         await promise;
         proc.process.on("exit", () => {
            delete this.serverProc[serverType];
         });
      }
      return this.getProc(serverType);
   }
   async stopProc(serverType, force = false){
      if (this.hasProc(serverType))
      if (force)
         await this.getProc(serverType).forceStop();
      else
         await this.getProc(serverType).stop();
   }

   async startProcType(type, setupAutoRestart = true){
      if (this.hasProc(type)){
         return;
      }
      this.logger.info("正在启动 %s", type);
      const proc = await this.runProc(type);
      if (setupAutoRestart){
         this.registerAutoRestart(
            type,
            proc,
            this.startProcType.bind(
               this,
               type, setupAutoRestart
            )
         );
      }
      this.setProcEnd(type, false);
   }
   async stopProcType(type){
      this.setProcEnd(type, true);
      if (this.hasProc(type)){
         this.logger.info("正在停止%s", type);
         await this.stopProc(type);
      }
   }
   async startFrpc(){
      return this.startProcType("frpc", true);
   }
   async stopFrpc(){
      return this.stopProcType("frpc");
   }
   async startSshProxy(){
      return this.startProcType("sshProxy", true);
   }
   async stopSshProxy(){
      return this.stopProcType("sshProxy");
   }
   async startServer(){
      await this.startProcType("imcServer", true);
      if (!this.isOutputAvailable()){
         this.setOutput("imcServer");
      }
   }
   async stopServer(){
      return this.stopProcType("imcServer");
   }
   async startMariadb(){
      await this.startProcType("mariadb", false);
   }
   async stopMariadb(){
      await this.stopProcType("mariadb");
   }

   async startAll(){
      await this.startMariadb();
      await this.startSshProxy();
      await this.startProcType("v2rayProxy", true);
      await this.startProcType("sfServer", true);
      await this.startServer();
      await this.startFrpc();
   }
   async stopAll(){
      await this.stopServer();
      await this.stopProcType("sfServer");
      await this.stopProcType("v2rayProxy");
      await this.stopSshProxy();
      await this.stopFrpc();
      await this.stopMariadb();
   }

   triggerCallbacks(callbacks, ...args){
      this.#triggerCallbacks(callbacks, ...args);
   }
   async #triggerCallbacks(callbacks, ...args){
      for (const cb of callbacks){
         try {
            await cb(...args);
         } catch(e){
            this.logger.error(e);
         }
      }
   }

   startScript(){
      this.addLowLevelCommand();
 
      this.readline = readline.createInterface({
         input: process.stdin,
         output: process.stderr,
      });
      this.readline.on("line", this.nextCommand.bind(this));
      this.callbacks.scriptStop.push(() => this.readline.close());

      cron.schedule(backupSchedule, this.startCreateBackup.bind(this));
      
      const stopScript = this.stopScript.bind(this);
      process.on("SIGINT", stopScript);
      process.on("SIGHUP", stopScript);
      process.on("SIGQUIT", stopScript);
      process.on("SIGTERM", stopScript);
      process.on("SIGTSTP", stopScript);
      this.readline.on("close", stopScript);

      const caughAll = this.caughAll.bind(this);
      process.on("uncaughtException", caughAll);
      process.on("unhandledRejection", caughAll);

      const runServers = async () => {
         const errors = [];
         try {
            await this.startAll();
         } catch(e) {
            errors.push(e);
            try {
               await this.stopAll();
            } catch(e){
               errors.push(e);
            }
         }
         if (errors.length > 0){
            logger.info("启动时出现错误", ...errors);
         }
      };
      runServers();

      this.callbacks.scriptStop.push(this.stopAll.bind(this));
      this.callbacks.scriptStop.push(this.stopAllProcess.bind(this));
      
      this.logger.info("程序正在运行");
   }

   async autoRestartServer(proc){
      if (this.serverStopped){
         return;
      }
      if (this.flags.autoRestartServer){
         return;
      }
      this.flags.autoRestartServer = true;
      this.logger.info("检测到服务器非正常退出");

      if (this.isRestartLimit("imcServer")){
         this.logger.info("异常重启的尝试过多，等待2分钟后再尝试重启");
         for (let i = 0; i < 120; i++){
            await timeWait(1000);
            if (this.serverStopped){
               break;
            }
         }
      }
      if (this.serverStopped){
         this.logger.info("服务器被手动设置为停止，不再自动重启");
         return;
      }
      this.logger.info("正在重新启动服务器");
      await this.restartServer();
      this.flags.autoRestartServer = false;
   }
   
   
   nextCommand(line){
      if (line.startsWith("+")){
         this.resolveCommand(line.slice(1));
      } else if (/^stop\s*/.test(line)){
         this.stopScript();
      } else {
         this.sendCommand(line);
      }
   }
   caughAllLimit = new RestartLimit({ interval: 3 * 60 * 1000, maxTimes: 10 });
   caughAll(e){
      this.logger.error("未知的错误", e);
      if (this.caughAllLimit.next()){
         this.logger.error("错误过多，关闭程序");
         process.exit(1);
      } else {
         this.logger.warn("将会关闭所有进程以降低风险");
         this.stopAll().finally(() => this.stopAllProcess());
      }
   }

   sendCommand(output, command){
      if (command == null){
         command = output;
         output = this.output;
      }
      let process;
      if (typeof output === "string"){
         try {
            process = this.getProc(output);
            if (process == null){
               this.logger.warn("输出源", output, "未启动");
            }
         } catch {
            this.logger.warn("输出源", output, "不存在");
         }
      } else if (output){
         if (output.stopped){
            this.logger.warn("输出进程", output.process.pid, "未在运行");
         } else {
            process = output;
         }
      }
      if (process == null){
         this.logger.warn("没有可用的输出进程，无法发送命令");
      } else {
         try {
            this.#procSendCommand(process.process, command);
         } catch(e){
            this.logger.warn("发送命令时出现错误", e);
         }
      }
   }
   #procWrite(process, text){
      process.stdin.write(text);
   }
   #procSendCommand(process, command){
      process.stdin.write(command);
      process.stdin.write("\n");
   }
   resolveCommand(command){
      const params = [];
      for (let subcommand = command; subcommand.length > 0;){
         const nextArgResult = firstArg(subcommand);
         if (nextArgResult == null){
            break;
         }
         params.push(nextArgResult.arg);
         subcommand = nextArgResult.subcommand.trim();
      }
      const label = params[0] ?? "help";
      const commandFunc = this["command_" + label];
      if (!commandFunc){
         this.logger.info("未知的命令，使用help查看帮助");
         return;
      }
      commandFunc.call(this, label, command.slice(label.length), ...params.slice(1));
   }
   command_serverStart(){
      this.startServer();
   }
   command_serverRestart(){
      this.restartServer();
   }
   command_serverStop(){
      this.stopServer();
   }
   command_restartAll(){
      this.fullRestartServer();
   }
   command_startBackup(){
      this.startCreateBackup();
   }
   command_newBackup(){
      this.newBackup();
   }
   command_fetchGrakkit(){
      this.runProc("grakkitFetch");
   }
   command_buildGrakkit(){
      this.runProc("grakkitBuild");
   }
   command_stopGrakkitDev(){
      this.stopProc("grakkitAutoFetch");
      this.stopProc("grakkitWatch");
   }
   command_runGrakkitDev(){
      this.runProc("grakkitAutoFetch");
      this.runProc("grakkitWatch");
   }
   command_setStopped(label, param, serverType){
      if (serverType in this.serverProcType){
         this.setProcEnd(serverType, true);
         this.logger.info("已将服务器类型 %s 设为停止状态", serverType);
      } else {
         this.logger.info("未知的服务器类型:", serverType);
      }
   }
   command_ps(){
      console.log("目前有以下进程正在运行:");
      console.log(...Object.keys(this.serverProc));
   }
   command_run(label, param, serverType, autoRestart){
      autoRestart = autoRestart === "true";
      if (!this.hasProc(serverType) && !(serverType in this.serverProcType)){
         this.logger.info("未知的服务器类型:", serverType);
         return;
      }
      if (this.hasProc(serverType)){
         this.logger.info("指定的服务器类型已经在运行了");
         return;
      }
      if (this.isProcRestarting(serverType)){
         this.logger.info("指定的服务器类型正在自动重启");
         return;
      }
      this.startProcType(serverType, autoRestart);
   }
   command_stop(label, param, serverType, withEnd){
      withEnd = withEnd === "true";
      if (!this.hasProc(serverType) && (serverType in this.serverProcType)){
         this.logger.info("未知的服务器类型:", serverType);
         return;
      }
      if (!this.hasProc(serverType)){
         this.logger.info("指定的服务器类型未在运行");
         return;
      }
      if (withEnd){
         this.stopProcType(serverType);
      } else {
         this.stopProc(serverType);
      }
   }
   command_kill(label, param, serverType, withEnd){
      withEnd = withEnd === "true";
      if (!(serverType in this.serverProcType)){
         this.logger.info("未知的服务器类型:", serverType);
         return;
      }
      if (!this.hasProc(serverType)){
         this.logger.info("指定的服务器类型未在运行");
         return;
      }
      if (withEnd){
         this.setProcEnd(serverType, true);
         this.stopProc(serverType, true);
      } else {
         this.stopProc(serverType, true);
      }
   }
   command_help(){
      this.logger.info("+help");
      console.log("可用命令: "
         + "\n" + "+server{Start,Restart,Stop} {服务器,Mariadb}{重启,关闭}"
         + "\n" + "+restartAll 顺序重启服务器和Mariadb"
         + "\n" + "+{start,new}Backup {启动备份过程,直接创建新的备份}"
         + "\n" + "+{run,stop,kill} <serverType> [{autoRestart:bool,withEnd:bool,withEnd:bool}] {启动,停止,杀死}特定类型的单例进程"
         + "\n" + "+output [serverType] 切换命令发送位置"
         + "\n" + "+{cmd,shell} 发送{服务器,shell}命令"
         + "\n" + "+send <output> <command>发送命令"
         + "\n" + "+{build,fetch}Grakkit"
         + "\n" + "+{run,stop}GrakkitDev"
         + "\n" + "+setStopped <serverType >"
         + "\n" + "+l<funcName> 调用函数<funcName>"
         + "\n" + "+lllist 列出所有函数"
         + "\n" + "+ps 列出正在运行的进程"
         + "\n" + "+eval <code> eval函数"
      );
   }
   command_output(label, param, type){
      this.setOutput(type ?? "");
   }

   isOutputAvailable(){
      if (typeof this.output === "string"){
         return this.hasProc(this.output);
      } else if (this.output != null){
         return !this.output.stopped;
      } else {
         return false;
      }
   }
   setOutput(newOutput){
      if (this.hasProc(newOutput)){
         this.output = newOutput;
      } else if (newOutput in this.serverProcType){
         this.output = newOutput;
      } else if (newOutput.length === 0){
         this.output = this.output === "imcServer"
            ? "shell"
            : "imcServer";
      } else {
         this.logger.error("未知的输出源:", newOutput);
         return;
      }
      this.logger.info("输出源:", this.output);
   }
   command_shell(label, param, ...args){
      this.sendShellCommand(param);
   }
   command_cmd(label, command){
      this.sendCommand("imcServer", command);
   }
   command_send(label, param, ...args){
      const nextArgInfo = firstArg(param);
      if (nextArgInfo == null){
         logger.error("未知错误", nextArgInfo, new Error("无法解析参数"));
         return;
      }
      const output = nextArgInfo.arg;
      const commandText = nextArgInfo.subcommand;
      this.sendCommand(output, commandText);
   }
   async command_runCustom(label, command, name, ...procParams){
      if (procParams.length === 0){
         console.log("未指定足够的参数， 需要 <name> <command> [...params]");
      }
      const fullName = "custom:" + name;
      if (this.hasProc(fullName)){
         this.logger.error("名称为", name, "的进程已经在运行了！");
         return;
      }
      try {
         await this.runProc(fullName, CustomServerProc, name, ...procParams);
      } catch(e){
         this.logger.error("无法启动", fullName, "，你是否正确指定了参数？", e);
      }
   }
   command_eval(label, code){
      this.logger.trace("eval", code);
      console.log(code);
      try {
         console.log(eval(code));
      } catch(e) {
         console.log(e);
      }
   }
   command_lllist(){
      console.log("所有可用方法如下:");
      for (const name of this.lowlevelMethod){
         console.log(name);
      }
      console.log("所有可用函数如下:");
      for (const name in this.lowLevelFunc){
         console.log(name);
      }
      console.log("所有可用服务类型如下:");
      for (const name in this.serverProcType){
         console.log(name);
      }
   }
   addLowLevelCommand(){
      for (const name of this.lowlevelMethod){
         if (!(name in this))
            throw ReferenceError("no such method: " + name);
         function run(label, subcommand, ...params){
            this.logger.info("控制台要求运行方法", name, params);
            this[name](...params);
         }
         this["command_l" + name] = run;
      }
      for (const name in this.lowLevelFunc){
         function run(label, subcommand, ...params){
            this.logger.info("控制台要求运行函数", name, params);
            this.lowLevelFunc[name].call(null, params);
         }
         this["command_l" + name] = run;
      }
   }
   
   sendServerCommand(line){
      this.sendCommand("server", line);
   }
   
   sendShellCommand(line){
      if (this.hasProc("shell")){
         this.sendCommand("shell", line);
      } else {
         this.logger.info("尝试向Shell发送命令，但Shell未在运行");
         this.logger.info("启动新的Shell进程中");
         this.runProc("shell").then(() => {
            this.sendCommand("shell", line)
         });
      }
   }
   
   async fullRestartServer(){
      this.logger.info("重启所有服务中");
      await this.stopAll();
      await this.startAll();
   }
   
   async restartServer(){
      this.logger.info("重启服务器中");
      await this.stopServer();
      await this.startServer();
   }
   
   async restartMariadb(){
      this.logger.info("重启服务器中");
      await this.stopMariadb();
      await this.startMariadb();
   }
   
   async startCreateBackup(){
      if (this.flags.backupRunning){
         this.logger.error("另一个备份过程正在运行！！！不执行新的备份过程");
         return;
      }
      this.flags.backupRunning = true;
      this.logger.info("开始服务器备份");
      this.logger.info("正在关闭服务进程");
      await this.stopAll();
      this.logger.info("开始创建备份");
      await this.newBackup();
      this.logger.info("备份已结束，重新启动所有服务");
      await this.startAll();
      this.flags.backupRunning = false;
   }

   stopScript(){
      this.#stopScript();
   }

   async #stopScript(timeout = 180 * 1000){
      if (this.flags.stopping){
         return;
      }
      this.flags.stopping = true;
   
      this.logger.info("正在结束程序……");
      
      if (timeout != null)
         setTimeout(() => {
            this.logger.error("脚本退出超时，强行结束程序……");
            process.exit(1);
         }, timeout);
      
      await this.#triggerCallbacks(this.callbacks.scriptStop);
      this.logger.info("程序已结束。");
      process.exit(0);
   }
   
   async newBackup(){
      const promise = createPendingPromise();
      const bakProc = new BackupServerProc();
      bakProc.process.on("exit", promise.resolve);
      setTimeout(promise.reject, 20 * 60 * 1000);
      try {
         await promise.promise;
         this.logger.info("备份已创建");
      } catch {
         this.logger.info("备份创建超时");
      }
      bakProc.stop();
   }
   async stopAllProcess(){
      await Promise.allSettled(
         [...CustomServerProc.processList].map(p => p.stop())
      );
      await Promise.allSettled(
         [...ImcServerProc.processList].map(p => p.stop())
      );
      await Promise.allSettled(
         [...MariadbServerProc.processList].map(p => p.stop())
      );
      await Promise.allSettled(
         [...ServerProc.processList].map(p => p.stop())
      );
      this.flags = {};
   }
}

class ServerProc {
   static processList = new Set();
   logProcessStatus = true;
   get logger(){
      if (this.#logger == null){
         this.#logger = log4js.getLogger(this.processType);
         if (!this.logProcessStatus){
            this.#logger.level = "off";
         }
      }
      return this.#logger;
   }
   #logger;
   get process(){
      return this.#process;
   }
   get stopped(){
      if (this.process.exitCode != null
      || this.process.signalCode != null){
         this.#stopped = true;
         /*
         setTimeout(() => {
            if (ServerProc.processList.has(this)){
               this.#onExit(this.process.exitCode, this.process.signalCode);
            }
         }, 1000);
         */
      }
      return this.#stopped;
   }
   #process;
   processType = "进程";
   toString(){
      return `[${this.constructor.name} (${this.processType})] PID: ${this.process.pid}`;
   }
   constructor(process){
      const onSpawn = () => {
         this.logger.info(`PID: ${process.pid} 已创建`);
         process.off("error", onSpawnError);
      };
      const onSpawnError = (e) => {
         this.logger.warn("启动失败", e);
      };
      this.#process = process;
      process.once("spawn", onSpawn);
      process.once("error", onSpawnError);
      process.on("exit", this.#onExit.bind(this));
      ServerProc.processList.add(this);
   }
   #onExit(code, signal){
      ServerProc.processList.delete(this);
      this.#stopped = true;

      let stat;
      if (code != null){
         stat = "代码 ";
      } else {
         stat = "信号 ";
      }
      stat += code ?? signal;

      if (code !== 0)
         this.logger.warn(`PID: ${this.process.pid} 以 ${stat} 退出`);
      else
         this.logger.info(`PID: ${this.process.pid} 以 ${stat} 退出`);
      
      this.onExit(code, signal);
   }
   onExit(code, signal){
   }
   #stopped = false;
   stopSignal = "SIGTERM";
   stopTimeout = 60 * 1000;
   async stop(callStopFn, stopTimeoutFn){
      if (!callStopFn){
         callStopFn = () => {
            this.process.kill(this.stopSignal);
            this.logger.info(`向进程 ${this.process.pid} 发送了信号 ${this.stopSignal}。`);
         }
      }
      if (!stopTimeoutFn){
         stopTimeoutFn = this.forceStop.bind(this);
      }
      if (this.stopped){
         return;
      }
      
      this.logger.info("尝试结束", this.process.pid);

      await 1;

      if (!this.stopped);
      try {
         await callStopFn();
         this.logger.info(`等待${this.stopTimeout / 1000}秒以使进程完全退出。`);
         const promise = createPendingPromise();
         setTimeout(promise.reject, this.stopTimeout);
         this.process.on("exit", promise.resolve);
         try {
            await promise.promise;
         } catch {
            this.logger.warn(`进程${this.process.pid} 关闭超时。`);
            await stopTimeoutFn();
         }
      } catch(e) {
         this.logger.error(`尝试关闭进程${this.process.pid} 时出现未知错误：`, e);
      }
      
      if (!this.stopped){
         this.logger.warn(this.process.pid, "未能成功关闭");
      }
      
   }
   async forceStop(){
      if (this.stopped){
         return;
      }
      this.logger.warn("正在杀死", this.process.pid);
      this.process.kill("SIGKILL");
      await timeWait(1000);
   }
}
class InputOutputServerProc extends ServerProc {
   processType = "输入输出进程";
   constructor(params, stdio, option = {}){
      const proc = child_process.spawn(params[0], params.slice(1), Object.assign({}, option, { stdio }));
      super(proc);
   }
}
class CommandInputOnlyServerProc extends InputOutputServerProc {
   processType = "仅命令输入进程";
   constructor(params, option = {}){
      super(params, ["pipe", "ignore", "ignore"], option);
   }
}
class CommandInputServerProc extends InputOutputServerProc {
   processType = "命令输入进程";
   constructor(params, option = {}){
      super(params, ["pipe", process.stdout, process.stderr], option);
   }
   stopCommand = "stop";
   async stop(...args){
      if (args.length > 0){
         await super.stop(...args);
      } else if (this.stopCommand != null){
         await super.stop(this.#sendStopCommand.bind(this), null);
      } else {
         await super.stop();
      }
   }
   #sendStopCommand(){
      try {
         this.process.stdin.write(this.stopCommand);
         this.process.stdin.write("\n");
      } catch {
         // ignored
      }
      this.logger.info(`向 ${this.process.pid} 发送了停止命令 ${this.stopCommand}。`);
   }
}
class ServerInstanceProc extends CommandInputServerProc {
   static processList = new Set();
   processType = "Instance";
   stopCommand = "stop";
   constructor(serverDir, serverCmd = "./start.sh", ...args){
      super([serverCmd, ...args], { cwd: serverDir });
      ServerInstanceProc.processList.add(this);
   }
   #onExit(code, signal){
      ServerInstanceProc.processList.delete(this);
   }
   onExit(code, signal){
      this.#onExit(code, signal);
      super.onExit(code, signal);
   }
}
class BackgroundServerProc extends ServerProc {
   processType = "后台服务进程";
   constructor(...params){
      const proc = child_process.spawn(params[0], params.slice(1), {
         stdio: "ignore"
      });
      super(proc);
   }
}
class ForegroundServerProc extends ServerProc {
   processType = "前台服务进程";
   constructor(...params){
      const proc = child_process.spawn(params[0], params.slice(1), {
         stdio: ["ignore", process.stdout, process.stderr]
      });
      super(proc);
   }
}
class CustomServerProc extends CommandInputServerProc {
   static processList = new Set();
   stopTimeout = 15 * 1000;
   stopCommand = null;
   constructor(name, ...params){
      super(params);
      this.processType = `custom:${name}`;
      CustomServerProc.processList.add(this);
   }
   #onExit(code, signal){
      CustomServerProc.processList.delete(this);
   }
   onExit(code, signal){
      this.#onExit(code, signal);
      super.onExit(code, signal);
   }
}

class V2rayProxyProc extends BackgroundServerProc {
   processType = "proxy";
   constructor(){
      super("bash", "./v2ray/start.sh");
   }
}
class HttpProxyProc extends ForegroundServerProc {
   processType = "httpProxy";
   constructor(...args){
      super(process.argv[0], "httl-proxy2.js", ...args);
   }
}
class SshProxyProc extends ForegroundServerProc {
   processType = "sshProxy";
   constructor(confFile){
      super("bash", "sshproxy.sh");
   }
}
class FrpcProc extends ForegroundServerProc {
   processType = "frpc";
   constructor(confFile){
      super("./frp/frpc", "-c", confFile);
   }
}
class SelfServerProc extends ServerInstanceProc {
   processType = "sfServer";
}
class ImcServerProc extends ServerInstanceProc {
   static processList = new Set();
   processType = "IMC";
   stopCommand = "stop";
   constructor(serverDir){
      super(serverDir);
      ImcServerProc.processList.add(this);
   }
   #onExit(code, signal){
      ImcServerProc.processList.delete(this);
   }
   onExit(code, signal){
      this.#onExit(code, signal);
      super.onExit(code, signal);
   }
}
class MariadbServerProc extends BackgroundServerProc {
   static processList = new Set();
   processType = "Mariadb";
   constructor(dataDir){
      super("./mariadb/start-mariadbd.sh", dataDir);
      MariadbServerProc.processList.add(this);
   }
   onExit(code, signal){
      MariadbServerProc.processList.delete(this);
      super.onExit(code, signal);
   }
}
class BackupServerProc extends ForegroundServerProc {
   processType = "备份";
   constructor(){
      super("./mkbackup.sh");
   }
}
class ShellServerProc extends CommandInputServerProc {
   processType = "Shell";
   stopCommand = "exit";
   stopTimeout = 10 * 1000;
   command;
   constructor(command){
      if (command)
         super(["/bin/bash", "-c", command]);
      else
         super(["/bin/bash"]);
      this.command = command;
   }
   async stop(){
      await this.forceStop();
   }
}

class GrakkitTscBuildProc extends ForegroundServerProc {
   logProcessStatus = true;
   static processList = new Set();
   processType = "GrakkitTscBuild";
   stopTimeout = 10 * 1000;
   constructor(watch = false){
      if (watch){
         super("grakkit/watch.sh");
      } else {
         super("grakkit/build.sh");
      }
      this.logProcessStatus = !!watch;
      GrakkitTscBuildProc.processList.add(this);
   }
   onExit(){
      GrakkitTscBuildProc.processList.delete(this);
      super.onExit();
   }
}
class GrakkitGitFetchProc extends ForegroundServerProc {
   logProcessStatus = false;
   static processList = new Set();
   stopTimeout = 10 * 1000;
   processType = "GrakkitGitFetch";
   constructor(cycle){
      if (cycle)
         super("grakkit/fetch.sh", "cycle");
      else
         super("grakkit/fetch.sh");
      this.logProcessStatus = !!cycle;
      GrakkitGitFetchProc.processList.add(this);
   }
   onExit(){
      GrakkitGitFetchProc.processList.delete(this);
      super.onExit();
   }
}

/* Utils */

function runRegularShell(){
   LOGGER.warn("正在运行真实Shell，所有操作将会被暂停！！！");
   child_process.execFileSync("bash", [ "-l" ], { stdio: "inherit" });
   LOGGER.info("真实Shell已退出。");
}

function firstArg(cmd){
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

class RestartLimit {
   record = [];
   maxTimes = 3;
   interval = 3 * 60 * 1000;
   next(){
      this.record.push(Date.now());
      return this.exceed();
   }
   constructor(option){
      if (!option) return;
      if (option.maxTimes != null){
         this.maxTimes = option.maxTimes;
      }
      if (option.interval != null){
         this.interval = option.interval;
      }
   }
   exceed(){
      const now = Date.now();
      let { interval, maxTimes, record } = this;

      // 找到记录当中与当前时间的差距小于等于 interval 的数据的位置
      // 然后更新数据起点
      let minTime = now - interval;
      let cutIndex = 0;
      for (let i = 0; i < record.length; i++){
         cutIndex = i + 1;
         const time = record[i];
         if (time >= minTime){
            cutIndex -= 1;
            break;
         }
      }
      
      if (cutIndex !== 0){
         record = record.slice(cutIndex);
         this.record = record;
      }

      return record.length > maxTimes;
   }
}

function timeWait(millionseconds){
    const pending = createPendingPromise();
    setTimeout(pending.resolve, millionseconds);
    return pending.promise;
}
/**
 * 创建一个待定状态的 {@link Promise}，还有为此 Promise 设置结果的函数。
 */
function createPendingPromise() {
    let resolve, reject;
    const promise = new Promise((re, rj) => {
        //此处同步调用
        resolve = re;
        reject = rj;
    });
    return { resolve, reject, promise };
}

const LOGGER = log4js.getLogger("server:starter");
main();
