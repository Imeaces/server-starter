import log4js from "log4js";

log4js.configure({
   appenders: {
      stdout: { type: "stdout" },
   },
   categories: {
      default: {
         appenders: [ "stdout" ],
         level: "trace"
      }
   }
});

log4js.configure({
   appenders: {
      stdout: { type: "stdout" },
      stderr: { type: "stderr" },
      httpProxyLogFile: {
         type: "file",
         filename: "proxyLogs/httpProxy.log",
         maxLogSize: 131072,
         backups: 9,
         compress: true
      },
      logfile: {
         type: "file",
         filename: "logs/serverStarter.log",
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
         appenders: [ "defaultOut", "defaultErr", "logfile" ],
         level: "trace"
      },
      "http-proxy": {
         appenders: [ "defaultOut", "defaultErr", "httpProxyLogFile" ],
         level: "trace"
      },
      noLog: {
         level: "off",
         appenders: ["noLog"],
      }
   }
});

