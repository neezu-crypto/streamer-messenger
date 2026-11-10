'use strict';

// 통합 관리 센터의 "서비스 일시정지"가 공유 기본 RTDB의 servicePause/{serviceId}/active에 쓴 값을 읽는다.
// 일시정지 중에 멈춰도 되는 자동 실행(스케줄) 함수만 맨 앞에서 이 값을 확인하고 바로 끝낸다.
// 정산·환불·보관 기간 삭제처럼 멈추면 안 되는 함수는 이 확인을 넣지 않는다.
// 값이 없으면 서비스별 기본 상태를 따르며, 이 기본값은 관리자 센터(servicePause.js)와 점검 안내 게이트와 같아야 한다.
// 읽기에 실패하면 멈추지 않고 평소처럼 실행한다(점검 상태를 못 읽어서 서비스 기능이 끊기는 것을 막는다).

async function isServicePaused(db, serviceId, defaultPaused) {
  try {
    const active = (await db.ref(`servicePause/${serviceId}/active`).get()).val();
    return typeof active === 'boolean' ? active : defaultPaused;
  } catch (error) {
    console.warn(`서비스 일시정지 상태를 읽지 못해 평소처럼 실행합니다(${serviceId}):`, error && error.message ? error.message : error);
    return false;
  }
}

module.exports = { isServicePaused };
