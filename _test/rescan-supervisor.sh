#!/usr/bin/env bash
# 完整重走监督器：X 报错自动停 → 冷却后自动重启；只有"划到底"才收工。
# 不改任何 app 代码，只通过面板 API 编排。毒区检测：连续两轮在相近滚动数处报错 → 收手。
PORT=8787
NODE="${NODE:-node}"   # 默认用 PATH 里的 node；如需指定，运行前 export NODE=/path/to/node.exe
BODY='{"handle":"georgerussell63","maxTweets":0,"speed":"normal","images":"orig","tabs":"with_replies","forceTimeline":true,"maxMinutes":0}'
MAX_CYCLES=5
COOLDOWN=900
prev_scrolls=-1
now() { date +%H:%M:%S; }
get_status() { curl --noproxy '*' -s --max-time 20 "http://127.0.0.1:$PORT/api/status"; }
extract() { echo "$1" | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(JSON.stringify({tweets:j.tweets,newThisRun:j.newThisRun,scrolls:j.scrolls,elapsedSec:j.elapsedSec,stopReason:j.stopReason,error:j.error}));}catch(e){console.log('PARSE_FAIL');}});"; }

for ((cyc=1; cyc<=MAX_CYCLES; cyc++)); do
  # 等面板空闲
  for ((w=1; w<=30; w++)); do
    st=$(get_status)
    if echo "$st" | grep -q '"running":false'; then break; fi
    echo "[$(now)] waiting panel idle ($w)"; sleep 60
  done
  if ! echo "$st" | grep -q '"running":false'; then
    echo "[$(now)] panel never went idle, abort"; exit 2
  fi
  # 发起任务
  resp=$(curl --noproxy '*' -s --max-time 20 -X POST "http://127.0.0.1:$PORT/api/start" -H 'Content-Type: application/json' -d "$BODY")
  echo "[$(now)] cycle $cyc started: $resp"
  if ! echo "$resp" | grep -q '"ok":true'; then
    echo "[$(now)] start rejected, abort"; exit 3
  fi
  sleep 30
  # 轮询到结束
  n=0
  while :; do
    st=$(get_status)
    if echo "$st" | grep -q '"running":false'; then break; fi
    n=$((n+1))
    if [ $((n % 15)) -eq 0 ]; then echo "[$(now)] c$cyc $(echo "$st" | head -c 150)"; fi
    sleep 120
  done
  fin=$(extract "$st")
  echo "[$(now)] cycle $cyc FINISHED: $fin"
  reason=$(echo "$fin" | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).stopReason||'')}catch(e){console.log('')}});")
  scrolls=$(echo "$fin" | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).scrolls||0)}catch(e){console.log(0)}});")
  case "$reason" in
    *划到底*|*上限*)
      echo "=== CLEAN FINISH (cycle $cyc) ==="; exit 0;;
  esac
  if echo "$reason" | grep -q "异常提示"; then
    if [ "$prev_scrolls" -ge 0 ]; then
      diff=$(( scrolls - prev_scrolls )); [ $diff -lt 0 ] && diff=$(( -diff ))
      thresh=$(( prev_scrolls / 7 + 30 ))
      if [ "$diff" -le "$thresh" ]; then
        echo "=== POISONED-REGION SUSPECTED: died at scrolls $prev_scrolls then $scrolls (diff $diff <= $thresh) ==="
        exit 4
      fi
    fi
    prev_scrolls=$scrolls
    if [ "$cyc" -lt "$MAX_CYCLES" ]; then
      echo "[$(now)] X error stop, cooldown ${COOLDOWN}s -> cycle $((cyc+1))"
      sleep $COOLDOWN
    fi
  else
    echo "[$(now)] non-error stop ('$reason'), not retrying (manual review needed)"
    exit 5
  fi
done
echo "=== CYCLES EXHAUSTED ($MAX_CYCLES) ==="
