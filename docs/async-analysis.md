# 비동기 분석 작업
로컬 API에서 검토한 근거를 제출하고 PostgreSQL·pg-boss 워커로 분석한다. 저장된 분석을 검토에 반영하는 요청은 분석 제출과 별도로 보낸다.

## 실행
DATABASE_URL과 ANTHROPIC_API_KEY(또는 OPENAI_API_KEY)를 설정한다.
pnpm db:migrate, pnpm build 후 별도 터미널에서 pnpm start:api와 pnpm start:worker를 실행한다.
기존 검토 조회와 같은 loopback 접근 정책을 사용한다. 기본 HTTP 본문 상한은 1 MiB다.
GET /ready는 DB 테이블 준비 상태이며 워커 생존이나 공급자 연결 성공을 보장하지 않는다.

## 요청과 미리보기
공통 경로: /v1/owners/:ownerId/repositories/:repositoryId/work-items/:workItemId/analysis-jobs

POST <공통 경로>/preview 본문:
- evidence: evidence.json 전체 JSON 객체
- bindings: bindings.json 전체 객체. URL의 소유자·저장소·작업과 일치해야 한다.
- settings: provider(claude 또는 openai), model, modelEpoch, contextWindowTokens, maxInputTokens, maxOutputTokens, timeoutMs(최대 60000)
- transmission: allowedExcerptIds 배열과 선택적인 redactValues 문자열 배열

파일 경로를 서버가 대신 읽지 않는다. 미리보기는 외부 호출 없이 countRequest, analysisRequest, 전송 내역, cacheKey를 반환한다.
전송 본문을 확인한 뒤 동일 본문에 confirmedRequestKey: <cacheKey>를 추가하여 POST <공통 경로>로 제출한다.
미리보기와 제출의 성공 응답은 201이다. 동일 요청은 기존 jobId·상태·결과를 반환한다.
CLI 파일 캐시와 DB 작업 캐시는 저장소가 다르므로 서로 자동 조회하지 않는다.

## 조회와 결과
GET <공통 경로>/:jobId는 queued, running, succeeded, failed, needs_input과 result/error를 반환한다.
성공한 작업은 본문 없이 `POST <공통 경로>/:jobId/review`로 DB에서 검토를 시작한다. [검토 시작과 편집](archive-api.md#분석-작업에서-검토-시작)을 따른다.
기존 검토에 새 분석을 적용할 때는 `POST <공통 경로>/:jobId/review/rebase`에 최신 검토 버전과 사용자 표시를 보낸다. [기존 검토에 재분석 적용](archive-api.md#기존-검토에-재분석-적용)을 따른다.
CLI를 사용할 때는 성공 응답의 result를 analysis.json으로 저장하면 기존 pnpm cli review --analysis <파일> 명령으로 검토할 수 있다.
근거 원문을 결과에 포함하므로 원래 evidence 파일 경로가 없어도 검증할 수 있다.
원본·마스킹 값이 DB 요청 스냅샷에 보관된다. API 키는 요청에 넣지 않고 워커 환경으로만 제공한다.

## 실패와 복구
대기 요청은 DB에 먼저 저장되고 5초 주기의 dispatcher가 전달한다. API·워커 재시작에도 대기 요청을 다시 찾는다.
pg-boss 전달 재시도는 2회, 5초 간격이며 DB claim은 한 실행만 허용한다.
프로세스 종료나 결과 저장 실패 후 5분 lease가 만료되면 needs_input/execution_outcome_unknown으로 전환한다.
외부 요청 이후 오류도 needs_input으로 남기고 자동 재호출하지 않는다. usage가 null이어도 무과금을 뜻하지 않는다.
스키마 거부의 작업 조회 응답은 `error.validationCode`, `error.validationPath`, `error.validationRule`에 정해진 진단 값만 제공한다. 예를 들어 중복 질문은 `invalid_schema`, `/missingQuestions`, `uniqueItems`로 표시한다. 새 Claude 요청은 v6를 쓰며 이전에 승인해 저장한 작업은 당시 프롬프트와 요청 키를 사용한다.
공급자 키 누락은 전송 전이므로 키를 설정한 뒤 POST <공통 경로>/:jobId/retry에 confirmedRequestKey를 보내 재접수할 수 있다.
그 외 실패의 retry는 409다. 공급자 사용 내역을 확인하고 원인을 해결한 뒤 필요한 경우 새 modelEpoch로 새 요청을 명시적으로 만든다.
같은 요청을 다시 제출하는 것만으로 실패를 지우거나 유료 분석을 반복하지 않는다.

## 검증
기본 테스트는 모형 공급자로 미리보기·확인·범위 검사, 중복 전달, 키 누락·전송 실패, CLI 검토 복원을 확인한다.
migration이 적용된 전용 DB의 GIT_ANALYZE_TEST_DATABASE_URL을 지정하면 동시 접수·claim, 소유자 격리, 만료 복구를 추가 검사한다.
실제 공급자 호출·의미적 분석 품질과 pg-boss 프로세스 재시작 검증은 별도 환경에서 수행해야 한다.
