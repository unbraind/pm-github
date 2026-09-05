#!/usr/bin/env bash
# Proves an untagged release's changelog heading comes from the calendar
# version rather than from the clock, and that every generator invocation in
# this package asks for that.
#
# Why this exists separately from `npm run changelog:check`: that script only
# exercises the package.json invocation. `.github/workflows/release.yml` calls
# pm-changelog directly. If either side lost --date-from-version the two would
# disagree during a release -- one heading derived from the clock, the other
# from the version -- and the release would fail on the divergence rather than
# on the stale date the flag exists to remove.
set -euo pipefail
cd "$(dirname "$0")/.."
status=0

# 1. Static invariant: every generator invocation, in every tracked file, asks
#    for the version-derived date. Enumerated rather than assumed, because the
#    invocation lives in more places than the scripts named changelog*.
while IFS= read -r file; do
  sites=$(grep -c -- --release-version-from-package "$file")
  flagged=$(grep -c -- --date-from-version "$file" || true)
  if [ "$sites" -gt "$flagged" ]; then
    echo "FAIL: $file has $sites generator invocation(s) but only $flagged carry --date-from-version" >&2
    status=1
  else
    echo "ok - $file: $sites generator invocation(s), all flagged"
  fi
done < <(git ls-files -- package.json '.github/workflows/*.yml' '.github/workflows/*.yaml' \
         | xargs grep -l -- --release-version-from-package 2>/dev/null)
# Scope note: only files that EXECUTE the generator are in scope -- package.json
# scripts and the workflows. Source, docs, dist and test fixtures may mention
# the same flags while describing or exercising them, and holding those to an
# "every mention is flagged" rule would be a false positive (it is, in
# pm-changelog's own repository, which documents both spellings on purpose).

# 2. Behavioural: the flag is what makes the date version-derived. A probe
#    version deliberately unequal to today, so a clock-derived heading and a
#    version-derived heading cannot coincide and the assertion discriminates.
probe=2026.1.2
expected="## ${probe} - 2026-01-02"
today="$(date -u +%Y-%m-%d)"
today_heading="## ${probe} - ${today}"

# The heading forms a CORRECT generator can produce for the probe version, used
# to bound the unflagged control. The date half is bound to the actual clock
# date, not to the `YYYY-MM-DD` shape: a shape-only match accepts an impossible
# date such as `2026-13-40` and a stale one such as last week's, and those are
# exactly the malformed date implementations this gate exists to catch. The only
# date an unflagged run may legitimately carry is today's, because deriving the
# date from the clock IS the defect the flag removes.
#
# The version is escaped before interpolation; unescaped, its dots match any
# character and `## 2026X1Y2` would be accepted as a heading for 2026.1.2.
probe_re=$(printf '%s' "$probe" | sed 's/[].[^$*\/]/\\&/g')
control_is_recognised() {
  printf '%s' "$1" | grep -qE "^## ${probe_re}(-[0-9]+)?( - ${today})?$"
}

# `--self-test` exercises the matcher against a fixed matrix and exits non-zero
# on any disagreement. Normal execution only ever sees the one heading THIS
# checkout's generator happens to emit, so without this the accept/reject
# boundaries are unexercised and can regress silently.
if [ "${1:-}" = "--self-test" ]; then
  self_status=0
  while IFS='|' read -r want heading; do
    [ -z "$want" ] && continue
    if control_is_recognised "$heading"; then got=accept; else got=reject; fi
    if [ "$got" = "$want" ]; then
      echo "ok - $want $heading"
    else
      echo "FAIL: expected $want, got $got for '$heading'" >&2; self_status=1
    fi
  done <<SELFTEST
accept|## ${probe}
accept|## ${probe}-2
accept|## ${probe} - ${today}
accept|## ${probe}-2 - ${today}
reject|## ${probe} - 2026-01-02
reject|## ${probe} - 2026-13-40
reject|## ${probe} - 1999-01-01
reject|## ${probe} - garbage
reject|## ${probe}.3
reject|## ${probe}-rc1
reject|## 2026.1.20 - ${today}
reject|## 9999.1.1 - garbage
reject|## 2026X1Y2
reject|
SELFTEST
  exit $self_status
fi
# In pm-changelog's own repository the generator is the build output, not a
# dependency, so resolve it in that order rather than assuming node_modules.
if [ -x ./node_modules/.bin/pm-changelog ]; then bin="./node_modules/.bin/pm-changelog"
elif [ -f ./dist/cli.js ]; then bin="node ./dist/cli.js"
else bin="npx pm-changelog"; fi
# The generator refuses a truncated workspace read rather than silently
# omitting entries, so the unbounded controls the real scripts pass are
# required here too.
common=(--pm-root .agents/pm --stdout --pm-bin ./node_modules/.bin/pm
        --pm-arg=--output-budget --pm-arg=unbounded
        --pm-arg=--output-limit --pm-arg=unbounded
        --release-version "$probe")

with=$($bin "${common[@]}" --date-from-version 2>/dev/null | grep -m1 '^## ' || true)
without=$($bin "${common[@]}" 2>/dev/null | grep -m1 '^## ' || true)

if [ "$with" != "$expected" ]; then
  echo "FAIL: with --date-from-version expected '$expected', got '$with'" >&2; status=1
else
  echo "ok - with the flag the heading is version-derived: $with"
fi
# The unflagged run is the control: it proves the flag is doing the work.
# It must not be pinned to the clock form (`## <probe> - <today>`), which fails
# against pm-changelog 2026.9.2 -- that release stopped stamping the wall clock
# and emits the bare `## <probe>` instead. But it must not accept ANY differing
# heading either: a generator emitting a malformed heading, or one for the wrong
# version, would then be reported as "undated" and pass while proving nothing
# about the flag. So the control is an explicit allow-list of the two shapes a
# correct generator can produce for THIS probe version, and anything else fails.
# The bound is a GRAMMAR of the heading forms a correct generator produces for
# this probe version, not an enumerated list of spellings and not a delimiter
# class. Enumerating is too brittle -- the generator also emits a disambiguated
# `## <probe>-2` when a section for that version already exists. But merely
# excluding a trailing digit is far too permissive: `## <probe>.3` and
# `## <probe>-rc1` are OTHER versions, and `## <probe> - garbage` is a date
# position holding something that is not a date, which is exactly the shape a
# broken date implementation would emit. So: the bare version, an optional
# `-<n>` duplicate suffix, an optional ` - <today>` date, nothing else.
if [ -z "$without" ]; then
  echo "FAIL: without --date-from-version produced no heading, so the comparison proves nothing" >&2; status=1
elif [ "$without" = "$with" ]; then
  echo "FAIL: without --date-from-version the heading is already '$without', identical to the flagged run" >&2; status=1
elif ! control_is_recognised "$without"; then
  echo "FAIL: without --date-from-version expected a heading for ${probe} in a recognised form ('## ${probe}', optionally a '-<n>' duplicate suffix, optionally ' - ${today}'), got '$without' - the control cannot vouch for a heading form it does not recognise" >&2; status=1
elif [ "$without" = "$today_heading" ]; then
  echo "ok - without the flag the heading is clock-derived: $without (this is the defect the flag removes)"
else
  echo "ok - without the flag the heading is not version-derived: $without (this is the defect the flag removes)"
fi
exit $status
