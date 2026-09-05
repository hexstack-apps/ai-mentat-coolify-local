#!/bin/sh
# Mutation check: reintroduce each bug and assert the suite goes RED.
# A green suite proves nothing until a broken build fails it.
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0

mutate() {
  desc=$1; file=$2; from=$3; to=$4
  cp "$file" "$file.bak"
  python3 - "$file" "$from" "$to" <<'PY'
import sys
p,f,t=sys.argv[1],sys.argv[2],sys.argv[3]
s=open(p).read()
if f not in s:
    print("MUTATION-NOOP"); sys.exit(9)
open(p,'w').write(s.replace(f,t,1))
PY
  if [ $? -eq 9 ]; then
    echo "  SKIP (pattern absent — mutation is a no-op): $desc"
    mv "$file.bak" "$file"; FAIL=$((FAIL+1)); return
  fi
  if node --test 'test/*.js' >/dev/null 2>&1; then
    echo "  NOT CAUGHT: $desc"; FAIL=$((FAIL+1))
  else
    echo "  caught:     $desc"; PASS=$((PASS+1))
  fi
  mv "$file.bak" "$file"
}

echo "Mutation testing (each must be CAUGHT):"

mutate "JSONL parsed as a single JSON blob (breaks multi-VM)" lib/lima.js \
  "    try {
      vms.push(JSON.parse(t));
    } catch {
      skipped.push(t.slice(0, 120));
    }" \
  "    vms.push(JSON.parse(t));"

mutate "malformed line aborts the whole parse" lib/lima.js \
  "      skipped.push(t.slice(0, 120));" \
  "      return { vms: [], skipped: [] };"

mutate "missing status defaults to Running" lib/lima.js \
  "  return found ? (found.status || 'Unknown') : 'Absent';" \
  "  return found ? (found.status || 'Running') : 'Absent';"

mutate "Stopped counts as usable" lib/lima.js \
  "  return status === 'Running';" \
  "  return status !== 'Absent';"

mutate "Homebrew fallbacks removed" lib/lima.js \
  "    '/opt/homebrew/bin/limactl',   // Apple silicon Homebrew" \
  "    // removed"

mutate "unrunnable binary aborts the fallback search" lib/lima.js \
  "    if (exists(p) && canRun(p)) return p;" \
  "    if (exists(p)) return p;"

mutate "system limactl wins over the bundled binary" lib/lima.js \
  "  if (exists(bundledPath)) return bundledPath;" \
  "  if (canRun('limactl')) return 'limactl';"

mutate "error message loses its remedies" lib/lima.js \
  "    + '  • npm run download:lima   (fetches the bundled copy this app ships with)\\n'" \
  "    + ''"

mutate "buildPath drops its empty-PATH guard" lib/lima.js \
  "  const base = envPath || (isWin ? '' : '/usr/bin:/bin');" \
  "  const base = envPath;"

mutate "buildPath appends instead of prepending" lib/lima.js \
  "  return extra.join(sep) + sep + base;" \
  "  return base + sep + extra.join(sep);"

mutate "failsafe stops recording failures" lib/failsafe.js \
  "  recent.push({ at: Date.now(), op, message, context });" \
  "  ;"

mutate "failsafe buffer becomes unbounded" lib/failsafe.js \
  "  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);" \
  "  ;"

mutate "failsafe stops logging (buffer only)" lib/failsafe.js \
  "  sink('warn', op, message, context);" \
  "  ;"

mutate "recentFailures exposes the live buffer" lib/failsafe.js \
  "  return recent.slice();" \
  "  return recent;"

mutate "quietAsync rethrows" lib/failsafe.js \
  "    record(op, err, context);
    return fallback;
  }
}

/**
 * Fire-and-forget side effect." \
  "    record(op, err, context);
    throw err;
  }
}

/**
 * Fire-and-forget side effect."

echo
echo "caught $PASS / $((PASS+FAIL))"
[ "$FAIL" -eq 0 ] || exit 1
