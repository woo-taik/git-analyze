# 저장과 migration

소유자·저장소·원본 버전에 작업, 작업의 원본 연결, 분석 버전, 검토 버전을 저장한다. 작업과 원본의 소유자·저장소가 일치해야 연결할 수 있다. 분석 버전은 전송된 발췌와 모델 메타데이터를 보존한다. 검토 버전은 앞 버전과 분석 버전을 참조하며 확인과 철회 이력을 보존한다.

루트에서 `pnpm db:generate`로 SQL을 생성하고, 검토 후 `pnpm db:migrate`로 적용한다. migration은 서버 시작과 분리한다. 생성된 SQL과 Drizzle metadata는 함께 버전 관리한다.

`DATABASE_URL`은 루트 `.env` 또는 실행 환경에서 읽는다. `createDatabase()`는 pool을 만들고 `close()`를 제공한다. 연결·쿼리·오류 처리는 사용하는 실행 계층의 책임이다.

`db-archive`는 로컬 검토의 최신 보고서로 전체 버전 이력을 한 트랜잭션에 저장한다. 저장된 버전과 같은 이력을 다시 가져오면 중복이 생기지 않는다. 오래된 보고서나 이력이 갈라진 저장 요청은 거부한다. `resume-db`는 DB에 저장된 최신 버전을 읽어 모델 호출 없이 원본 근거와 문장을 출력한다. [CLI 사용법](../../docs/review-resume-cli.md#6-postgresql에-저장하고-문장-다시-출력)

PostgreSQL 연동 테스트는 마이그레이션한 전용 테스트 DB의 연결 URL을 `GIT_ANALYZE_TEST_DATABASE_URL`에 지정한 뒤 `pnpm check`로 실행한다. 테스트는 별도 소유자 ID에 fixture를 저장한다.
