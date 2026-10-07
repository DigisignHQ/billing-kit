#!/usr/bin/env bash
# Uses installed PostgreSQL and MongoDB binaries; never connects to existing databases.
set -euo pipefail
for binary in initdb pg_ctl mongod node; do command -v "$binary" >/dev/null; done
billing_tmp=$(mktemp -d "${TMPDIR:-/tmp}/billing-kit-test.XXXXXX")
mongo_pid=''
cleanup() {
  if [[ -n "$mongo_pid" ]]; then kill "$mongo_pid" 2>/dev/null || true; wait "$mongo_pid" 2>/dev/null || true; fi
  pg_ctl -D "$billing_tmp/pg" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$billing_tmp"
}
trap cleanup EXIT
# Override ports if already occupied. Each server binds only to loopback.
pg_port=${BILLING_KIT_PG_PORT:-55439}
mongo_port=${BILLING_KIT_MONGO_PORT:-57439}
initdb -D "$billing_tmp/pg" -A trust -U billing_test > "$billing_tmp/init.log"
pg_ctl -D "$billing_tmp/pg" -l "$billing_tmp/pg.log" -o "-h 127.0.0.1 -p $pg_port -k $billing_tmp" -w start
mkdir "$billing_tmp/mongo"
mongod --dbpath "$billing_tmp/mongo" --bind_ip 127.0.0.1 --port "$mongo_port" --logpath "$billing_tmp/mongo.log" > /dev/null 2>&1 &
mongo_pid=$!
export BILLING_KIT_TEST_POSTGRES_URL="postgresql://billing_test@127.0.0.1:$pg_port/postgres"
export BILLING_KIT_TEST_MONGODB_URL="mongodb://127.0.0.1:$mongo_port/?serverSelectionTimeoutMS=1000"
node --input-type=module <<'JS'
import {MongoClient} from 'mongodb';
let ready=false;
for(let i=0;i<20;i++) {
 const c=new MongoClient(process.env.BILLING_KIT_TEST_MONGODB_URL);
 try{await c.connect();ready=true;break;}catch{await new Promise(r=>setTimeout(r,250));}finally{await c.close();}
}
if(!ready)throw new Error('Disposable MongoDB failed to start');
JS
npm run test:integration
