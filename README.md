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

채팅방 미니게임은 진행 중에도 채팅을 사용할 수 있도록 채팅 패널의 인라인 카드에서 렌더링한다. 방별 `meta/miniGame`에는 게임 데이터와 진행 선택만 저장하고, 각 클라이언트가 사다리 화면을 렌더링한다. 소유자/관리자 선택은 실시간 공유되며 종료 결과는 공개 채팅 메시지로 남는다.

신고 검토, 메신저 전용 계정 정지·해제, 관리자 감사 기록은 메신저 페이지의 관리자 탭에서 제공한다. 신고는 상태별 페이지 조회, 처리 의견, 재검토, 증거 열람 기록을 지원한다. 정지 목록은 페이지 조회하며 메신저 전용 정지와 전체 서비스 정지를 구분한다. 관리자는 정지 대상이 될 수 없다. 관리자는 신고 증거와 감사 기록을 볼 수 있지만 일반 방 정보·신청·참여자·대화 내용을 임의로 읽을 수 없고, 신고 증거는 서버 경유로 열람한다. 서비스 정지는 메신저 페이지에서 관리하며 admin-center 계정 상세 화면과는 별도다.

배포 전에 `database.rules.json`이 6개 자매 프로젝트 사본과 바이트 단위로 같은지 확인하고, RTDB rules dry-run을 수행한다. Functions는 배포 함수명을 명시한다.
