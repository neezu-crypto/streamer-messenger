# streamer-messenger 작업 지침

이 프로젝트는 스트리머 메신저 웹앱이다. Firebase 프로젝트 `soop-stock-market`과
RTDB `soop-stock-market-default-rtdb`를 사용하며, Cloud Functions codebase는
`messenger`다.

## RTDB 규칙 동기화 — 모든 자매 프로젝트 공통

- RTDB 규칙을 보유한 여섯 저장소는 `StreamBet-Market`, `soop-stock-market`,
  `interior-3d-viewer`, `streamer-life-game`, `streamer-gallery`, `streamer-messenger`다.
  모두 같은 Firebase 프로젝트 및 RTDB를 사용한다. RTDB 규칙은 Firebase 프로젝트 전체에 적용되므로
  여섯 저장소의 `database.rules.json`은 항상 바이트 단위로 동일해야 한다.
- `StreamBet-Market`은 기준 원본이지만 규칙 수정 전에는 여섯 파일의 실제 내용과 최근 변경
  이력을 대조해 가장 최신의 합의된 규칙을 판단한다. 메신저 전용 조건을 추가·수정할 때도
  전체 규칙에 반영한 뒤 나머지 다섯 사본에 동일하게 동기화한다.
- 어느 저장소에서 규칙을 수정하든 여섯 파일 모두 같은 내용인지 diff/hash로 검증한다.
  배포 전 `firebase deploy --only database --project soop-stock-market --dry-run`을 실행하고,
  규칙 배포는 모든 자매 서비스에 영향을 준다는 점을 고려해 접근 조건을 검토한다.

## Cloud Functions

- 공유 Firebase 프로젝트의 함수 이름은 codebase와 무관하게 프로젝트·리전 전체에서
  유일해야 한다. 새 함수 이름은 배포 전에 `firebase functions:list --project soop-stock-market`
  으로 충돌을 확인한다.
- 배포할 때는 `messenger` codebase와 변경한 함수명만 지정한다. 전체 함수 배포는 다른
  자매 프로젝트 함수에 영향을 줄 수 있으므로 사용하지 않는다.
- RTDB 노드·필드는 실제 쓰기 코드와 대조하고, 함수·화면 변경 후 문법 검사와 흐름 검증을
  마친다.

## 관리자 방과 스트리머 방의 기능 일관성

- 채팅방 내부 기능을 추가·수정할 때 `streamer` 방만 대상으로 가정하지 않는다. 관리자 방(`admin`)에도 같은 사용 경험을 제공하는 것을 기본으로 하고, 기능을 제외해야 할 이유가 있으면 해당 작업에서 근거를 명시한다.
- 팬페이지 바로가기는 관리자 본인의 방에도 표시한다. 방 소유자라면 `admin` 방을 포함해 방 메타데이터의 본인 SOOP 아이디로 바로가기를 만들고, 참여자는 해당 스트리머 방의 SOOP 아이디를 사용한다. `roomType === 'streamer'` 조건만으로 소유자 본인의 바로가기를 숨기지 않는다.
- 바로가기 표시·이동을 검증할 때 스트리머 방 참여자와 스트리머/관리자 소유자 방을 모두 확인한다. 관리자의 프로필 SOOP 아이디를 쓸 때도 방에 연결된 값만 사용하고, 식별자를 임의 추정하지 않는다.

## 실시간 스트리머 인증 승인

- 메신저는 `users/{uid}/streamerVerified`와 `users/{uid}/streamerVerificationSwitchApproval`을 현재 로그인한 본인 UID 범위에서 구독한다. 페이지가 연결된 상태에서 인증 승인·해제 UI가 갱신되고, 계정 전환 승인 신호가 오면 공유 `requestStreamerVerification` callable로 요청을 검증해 세션을 전환한다.
- 전환 신호는 `{ requestId, approvedAt }`이며 서버가 승인 상태와 기존 인증 UID를 다시 확인한다. custom token은 RTDB에 저장하지 않고, 처리 후 승인 신호를 삭제한다. 경로·권한 변경은 공유 규칙 6개 사본과 모든 자매 클라이언트에 미치는 영향을 먼저 검토한다.
- 이 흐름은 페이지가 열려 있고 연결된 경우 동작한다. 페이지가 닫힌 상태에서의 푸시 알림은 구현되어 있지 않다. 인증·전환 수정 시 일반 승인, 오프라인 복귀, 계정 전환까지 확인한다.

## 작업 완료 후 배포

- 검증이 통과한 런타임 변경은 별도 확인 없이 작업 파일만 한글 커밋으로 커밋·push하고,
  GitHub Pages가 구성된 경우 배포 작업의 성공까지 확인한다.
- Cloud Functions를 수정했으면 `messenger` codebase와 변경 함수명만 지정해 서버에 배포한 뒤
  소스 변경도 커밋·push한다. 서버 코드 변경이 없으면 서버 배포는 생략한다.
- RTDB 규칙 변경은 여섯 자매 저장소에 동기화하고 해시 일치 및 dry-run을 확인한 뒤에만
  배포한다. 검증 실패·권한 부재·배포 범위 불확실성이 있으면 진행을 멈추고 원인을 알린다.
