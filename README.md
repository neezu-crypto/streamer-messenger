# 스트리머 메신저 (MVP 구현 중)

기존 `soop-stock-market` Firebase 계정과 RTDB를 공유하는 스트리머·팬 메신저.

## 로컬 실행

정적 파일이므로 프로젝트 디렉터리에서 간단한 HTTP 서버로 실행한다.

```sh
python3 -m http.server 8080
```

## Firebase

- Project: `soop-stock-market`
- RTDB: 공용 RTDB의 `streamerMessenger/` 경로
- Functions codebase: `messenger`
- Web: GitHub Pages (`https://neezu-crypto.github.io/streamer-messenger/`)
- Backend: Firebase Cloud Functions + RTDB

## 자매 프로젝트 자동 로그인

Firebase Auth는 기본적으로 사이트 출처별 저장소를 사용한다. 자매 사이트와 같은 `https://neezu-crypto.github.io` 출처 아래에서 서비스하므로, 같은 Firebase 프로젝트/API 키와 기본 앱 이름을 사용하는 기존 로그인 세션을 이어받는다. `file://`, `localhost`, 서로 다른 `*.web.app` 사이트에서는 브라우저 출처가 달라 기존 세션을 읽을 수 없다. 그런 출처 간 자동 로그인이 필요하면 자매 페이지에서 짧은 수명의 인증 handoff를 보내는 별도 SSO 연동이 필요하다.

## 구현 구성

- `index.html`, `styles.css`, `js/`: 모바일/PC 메신저 UI와 기존 계정 로그인 연결
- `functions/src/auth.js`: 공유 계정, 인증 스트리머, 관리자, 정지 상태 확인
- `functions/src/messenger.js`: 방·신청·메시지·갤러리 참조·신고 callable 및 보관 스케줄러
- `database.rules.json`: 스트리머 타임라인과 팬별 메시지 읽기 권한
- `privacy.html`, `terms.html`: 데이터 보관 및 이용 안내

현재 1차 골격이며, 내보내기와 범위 지정 스크린샷, 알림 상태 동기화, 이전 메시지 페이지 로딩, admin-center 게임별 정지 UI는 이어서 구현한다. 구현 상태와 미완료 범위는 상위 폴더의 `스트리머-팬-메신저-기획서.md`에 기록한다.

배포 전에 `database.rules.json`이 6개 자매 프로젝트 사본과 바이트 단위로 같은지 확인하고, RTDB rules dry-run을 수행한다. Functions는 배포 함수명을 명시한다.
