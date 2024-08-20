#!/bin/sh

set -e

rm -rf .tmp

mkdir .tmp

curl -o .tmp/node.tar.gz https://nodejs.org/dist/v21.1.0/node-v21.1.0-linux-x64.tar.gz
git archive -o .tmp/src.tar --format tar --prefix=server-starter/ main

cd .tmp

tar -xf node.tar.gz

tar -xf src.tar

PATH=$PWD/node-v21.1.0-x64/bin:$PATH

export PATH

cd server-starter/

npm install -D
npm run build

cp server-starter_example.yml ../server-starter.yml || true
cp scripts/start.sh ../start.sh || true

cd ..

tar -zcf ../server-starter-linux-x64.tar.gz server-starter/ node-v21.1.0-linux-x64/ start.sh server-starter.yml

cd ..

rm -rf .tmp
