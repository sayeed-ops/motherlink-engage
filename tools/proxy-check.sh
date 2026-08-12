#!/usr/bin/env bash
# Validate ISP proxies before binding them to AdsPower profiles.
#
#   chmod +x proxy-check.sh
#   PROXY_USER=xxx PROXY_PASS=yyy ./proxy-check.sh proxies.txt
#
# proxies.txt — one "host:port  label" per line (get host:port from your provider's
# endpoint list; '#' comments and blank lines are ignored). proxies.txt is
# gitignored: real endpoints belong in the ops vault, never in this repo.
#
#   203.0.113.10:10001   label-one
#   203.0.113.11:10001   label-two
#   203.0.113.12:10001   label-three
#
# Run it FROM THE POSTING MAC — that is where the real traffic will originate.

set -uo pipefail

UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
LIST="${1:-proxies.txt}"

[ -f "$LIST" ] || { echo "usage: PROXY_USER=.. PROXY_PASS=.. $0 proxies.txt" >&2; exit 1; }
: "${PROXY_USER:?set PROXY_USER}"
: "${PROXY_PASS:?set PROXY_PASS}"

# <endpoint> <url> -> "<http_code> <seconds>"
probe() {
  curl -sS -x "http://${PROXY_USER}:${PROXY_PASS}@$1" -A "$UA" \
       --max-time 25 -o /dev/null -w '%{http_code} %{time_total}' "$2" 2>/dev/null \
    || printf 'ERR -'
}

while read -r endpoint label; do
  [ -z "${endpoint:-}" ] && continue
  case "$endpoint" in \#*) continue ;; esac

  printf '\n== %s  (%s)\n' "${label:-$endpoint}" "$endpoint"

  case "$endpoint" in
    *:PORT|*:port|*:[!0-9]*)
      echo "   SKIPPED     '${endpoint##*:}' is not a port number. Replace the"
      echo "               placeholder with the real port from the Decodo"
      echo "               dashboard (Proxy setup / endpoint list)."
      continue
      ;;
  esac

  info=$(curl -sS -x "http://${PROXY_USER}:${PROXY_PASS}@${endpoint}" -A "$UA" \
              --max-time 25 https://ipinfo.io/json 2>/dev/null)

  if [ -z "$info" ]; then
    echo "   CONNECT     FAIL - no response. Check host:port, credentials, and"
    echo "               whether this machine's IP needs whitelisting at Decodo."
    continue
  fi

  summary=$(printf '%s' "$info" | python3 -c 'import json,sys
d = json.load(sys.stdin)
print(d.get("ip",""), d.get("city",""), d.get("region",""),
      d.get("timezone",""), d.get("org",""), sep="|")' 2>/dev/null)

  if [ -z "$summary" ]; then
    echo "   CONNECT     responded but returned no JSON:"
    printf '   %s\n' "$info"
    continue
  fi

  IFS='|' read -r ip city region tz org <<<"$summary"

  echo "   EXIT IP     $ip"
  echo "   GEO         $city, $region"
  echo "   TIMEZONE    $tz        <- set this on the AdsPower profile"
  echo "   ORG         $org"

  read -r code secs <<<"$(probe "$endpoint" https://www.reddit.com/)"
  echo "   reddit.com      $code  (${secs}s)"
  read -r code secs <<<"$(probe "$endpoint" https://old.reddit.com/)"
  echo "   old.reddit.com  $code  (${secs}s)"

  echo "   reputation  https://scamalytics.com/ip/$ip"
  echo "               https://spur.us/context/$ip"
  echo "               https://www.ipqualityscore.com/free-ip-lookup-proxy-vpn-test/lookup/$ip"
done < "$LIST"

echo
