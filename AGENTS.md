# streamer-messenger 작업 지침

이 프로젝트는 스트리머 메신저 웹앱이다. Firebase 프로젝트 `soop-stock-market`과
RTDB `soop-stock-market-default-rtdb`를 사용하며, Cloud Functions codebase는
`messenger`다.

## RTDB 규칙 동기화 — 모든 자매 프로젝트 공통

- 이 저장소는 `StreamBet-Market`, `soop-stock-market`, `interior-3d-viewer`,
  `streamer-life-game`, `streamer-gallery`와 같은 Firebase 프로젝트 및 RTDB를 사용한다.
  RTDB 규칙은 Firebase 프로젝트 전체에 적용되므로 여섯 저장소의
  `database.rules.json`은 항상 바이트 단위로 동일해야 한다.
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

## 작업 완료 후 배포

- 검증이 통과한 런타임 변경은 별도 확인 없이 작업 파일만 한글 커밋으로 커밋·push하고,
  GitHub Pages가 구성된 경우 배포 작업의 성공까지 확인한다.
- Cloud Functions를 수정했으면 `messenger` codebase와 변경 함수명만 지정해 서버에 배포한 뒤
  소스 변경도 커밋·push한다. 서버 코드 변경이 없으면 서버 배포는 생략한다.
- RTDB 규칙 변경은 여섯 자매 저장소에 동기화하고 해시 일치 및 dry-run을 확인한 뒤에만
  배포한다. 검증 실패·권한 부재·배포 범위 불확실성이 있으면 진행을 멈추고 원인을 알린다.
