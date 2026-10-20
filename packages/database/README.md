# 저장과 migration

초기 schema는 소유자·저장소·원본 버전 세 테이블이다. 다른 소유자의 저장소에 원본을 연결하지 못하도록 복합 외래 키를 둔다. 작업·분석·사용자 승인·결과 캐시는 해당 유스케이스 구현 시 migration으로 추가한다.

루트에서 `pnpm db:generate`로 SQL을 생성하고, 검토 후 `pnpm db:migrate`로 적용한다. migration은 서버 시작과 분리한다. 생성된 SQL과 Drizzle metadata는 함께 버전 관리한다.

`DATABASE_URL`은 루트 `.env` 또는 실행 환경에서 읽는다. `createDatabase()`는 pool을 만들고 `close()`를 제공한다. 연결·쿼리·오류 처리는 사용하는 실행 계층의 책임이다.
