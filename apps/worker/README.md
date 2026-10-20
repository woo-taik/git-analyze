# 백그라운드 작업

pg-boss runner와 네 가지 작업 이름을 준비했다. 수집·분석·결과 생성 핸들러는 아직 없으므로 일반 시작은 명시적으로 실패한다. 처리하지 않은 작업을 성공으로 소비하는 빈 핸들러는 등록하지 않는다.

Nest standalone context에서 `WorkerModule`과 `WorkerService`를 구성한다. `pnpm worker:check`는 설정 유무와 계획된 큐만 출력하며 DB 연결이나 작업 실행 성공을 뜻하지 않는다. 실제 핸들러는 `src/worker.service.ts`의 composition 지점에 연결한다. 종료 시 Nest 수명 주기로 큐를 정리한다. 큐 payload의 구조 검증 이후 소유권·입력 버전·멱등성 검증은 유스케이스에서 수행해야 한다.
