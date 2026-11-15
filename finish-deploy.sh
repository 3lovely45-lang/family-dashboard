#!/usr/bin/env bash
# 가족 대시보드 GitHub Pages 배포 마무리 스크립트
# 전제: 3lovely45-lang/family-dashboard 저장소가 존재하고, Pickle GitHub App이 그 저장소에
#       쓰기 권한(Contents write + Pages write)을 가지고 있어야 한다.
set -uo pipefail
OWNER=3lovely45-lang
REPO=family-dashboard
BRANCH=main
URL="https://${OWNER}.github.io/${REPO}/"
cd "$(dirname "$0")"

echo "== 1) 원격 확인 =="
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "https://github.com/${OWNER}/${REPO}.git"
fi
gh api "/repos/${OWNER}/${REPO}" >/dev/null 2>&1 || { echo "FAIL: 저장소 ${OWNER}/${REPO} 를 볼 수 없습니다 (없거나 Pickle App 권한 없음)."; exit 10; }

echo "== 2) 푸시 =="
git push -u origin "${BRANCH}" || { echo "FAIL: push 실패 (권한 확인 필요)"; exit 11; }

echo "== 3) Pages 활성화 =="
gh api -X POST "/repos/${OWNER}/${REPO}/pages" \
  -f build_type=legacy \
  -f 'source[branch]=main' \
  -f 'source[path]=/' >/dev/null 2>/tmp/pages_err.txt
if [ -s /tmp/pages_err.txt ]; then
  echo "-- POST /pages 응답: $(cat /tmp/pages_err.txt)"
fi
gh api "/repos/${OWNER}/${REPO}/pages" 2>&1 | head -30

echo "== 4) 빌드 상태 폴링 =="
for i in $(seq 1 30); do
  STATUS=$(gh api "/repos/${OWNER}/${REPO}/pages/builds/latest" --jq '.status + "/" + (.error.message // "-")' 2>/dev/null || echo "none/none")
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$URL")
  echo "[$i] build=${STATUS} http=${CODE}"
  if [ "$CODE" = "200" ] && [ "${STATUS%%/*}" = "built" ]; then
    echo "OK: ${URL}"
    exit 0
  fi
  sleep 20
done
echo "WAIT: 아직 빌드 중입니다. 나중에 ${URL} 를 확인하세요."
exit 12
