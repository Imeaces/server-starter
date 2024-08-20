#!/bin/sh

sh -x scripts/create-targz.sh

cat > server-starter-install.sh <<'EOM'
#!/bin/sh

set -e

if [ "$1" != install ]; then
   cp -f "$0" .tmp_install.sh
   sh .tmp_install.sh install
   rm .tmp_install.sh
   exit
fi

lines=27

exec 4<./.tmp_install.sh

i=0
while true; do
   if [ $i -ge $lines ]; then
      break
   fi
   i=`expr $i + 1`
   read -r rp
done <&4

tar -zxf - <&4
chmod +x start.sh
exit
EOM

cat server-starter-linux-x64.tar.gz >>server-starter-install.sh

rm server-starter-linux-x64.tar.gz
