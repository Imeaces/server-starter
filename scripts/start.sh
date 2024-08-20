#!/bin/sh

cd `dirname "$0"`

export PATH=$PWD/node-v21.1.0-linux-x64/bin:$PATH
export HOME=$PWD
export TZ=Asia/Shanghai
export LANG=zh_CN.UTF-8

if [ -f env.sh ]; then
   . ./env.sh
fi

exec node server-starter/server-starter.js
