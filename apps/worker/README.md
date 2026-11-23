# 백그라운드 분석
pg-boss의 analyze_work_item 핸들러를 연결했다. DATABASE_URL과 공급자 키를 설정한 후 migration, build, start:worker 순서로 실행한다.
5초마다 DB의 대기 작업을 큐에 전달한다. 큐 중복 전달은 DB의 원자적 claim으로 차단한다. 큐 전달은 다시 시도할 수 있지만 이미 시작한 외부 분석은 자동 반복하지 않는다.
실행 lease는 5분이며 만료 시 needs_input으로 표시한다. 공급자 호출 제한은 최대 60초다. 종료 시 dispatcher, 큐, DB 연결 순서로 정리한다.
worker:check는 설정·등록 핸들러만 출력한다. DB 접속·모델 연결을 검사하지 않는다.
[사용법](../../docs/async-analysis.md)
