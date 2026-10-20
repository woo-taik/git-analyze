# 기술 스택 및 아키텍처 검토

기준일: 2026-10-20. 상태: 구현 전 제안. 기술 선택의 평가는 현재 요구사항에 대한 설계 판단이며 벤치마크 결과가 아니다.

## 1. 권장안

**TypeScript + NestJS 기반 모듈형 모놀리스 + PostgreSQL + 백그라운드 워커**를 사용한다. HTTP 엔진은 Fastify 어댑터로 구성한다.

한 코드베이스와 DB로 시작한다. API와 워커는 같은 도메인 모듈을 사용하되 프로세스는 분리한다. 장시간 수집·LLM 호출이 HTTP 요청 수명에 묶이지 않도록 한다.

### 언어와 런타임

- TypeScript, Node.js 24 LTS 계열의 지원되는 보안 패치 버전.
- 프런트엔드·API·워커에서 데이터 계약과 검증 정의를 공유한다.
- 네트워크 I/O 중심의 작업에 맞추고, CPU 집약적 분석은 초기 범위에 넣지 않는다.
- Node LTS 상태는 [공식 릴리스 안내](https://nodejs.org/en/about/previous-releases)에서 구현 시 다시 확인한다.

### API

- NestJS의 Module·Controller·Provider로 HTTP 계층과 의존성 주입을 구성하고 Fastify 어댑터를 사용한다.
- 저장소별 공급자 연결, 수집 요청, 후보 검토, 사용자 확인, 결과 조회를 제공한다.
- JSON Schema를 계약의 기준으로 삼고 TypeScript 타입과 LLM 출력 스키마가 어긋나지 않게 한다. 업무 API를 추가할 때 Nest Pipe 등에서 명시적으로 검증한다. Fastify 어댑터를 사용한다는 이유만으로 Nest DTO 검증이 자동 적용된다고 가정하지 않는다. 공급자가 지원하는 스키마 부분집합은 어댑터에서 검사한다.
- CLI·워커는 Nest standalone application context로 같은 DI·수명 주기 규칙을 사용한다. 도메인 계약은 Nest와 분리한다.
- 근거: [NestJS Fastify 어댑터](https://docs.nestjs.com/techniques/performance), [NestJS 독립 실행 앱](https://docs.nestjs.com/application-context). 전체 시스템 속도는 별도 측정한다.

### 저장과 작업 큐

- PostgreSQL: 관계, 근거 스냅샷, 구조화 분석, 결과 캐시를 저장한다.
- Drizzle + `pg`: 타입 기반 쿼리와 SQL migration을 관리한다. 도메인 관계는 명시적 테이블로, 가변적인 공급자 응답·분석 필드는 JSONB로 저장한다.
- pg-boss: PostgreSQL 기반의 재시도·스케줄·백그라운드 작업에 사용한다. 별도 Redis를 운영하지 않는 구성을 우선한다.
- 큐의 보장과 무관하게 업무 처리는 멱등하게 만든다. 외부 LLM 호출의 중복 과금까지 DB 트랜잭션이 막아주지는 않는다.
- 근거: [PostgreSQL JSON 타입](https://www.postgresql.org/docs/current/datatype-json.html), [Drizzle 개요](https://orm.drizzle.team/docs/overview), [pg-boss 공식 저장소](https://github.com/timgit/pg-boss).

### 저장소 공급자와 LLM

- Git CLI 기반 공통 수집기: GitHub·Ncloud SourceCommit·일반 Git 원격에서 커밋·변경 파일·필요한 diff를 수집한다. 공급자별로 Git과 메타데이터 API 사용 여부를 설정한다.
- Octokit: GitHub의 PR·이슈·리뷰·검증 정보를 보강한다. 명시적인 연결 관계를 가져오는 데 유리한 부분만 GraphQL로 보완한다. GitHub API만으로 충분한 저장소는 API 경로를 유지한다.
- SourceCommit: HTTPS/SSH Git 연결을 우선한다. 공개 API는 저장소·브랜치·태그 관리 등 문서화된 범위만 사용하며, 커밋·PR·리뷰 API가 있다고 가정하지 않는다.
- 저장소 공급자는 수집 어댑터에서 정규화한다. 이후 검사·LLM·기간 집계는 공급자 중립적인 데이터를 사용한다. 상세는 [다중 저장소 공급자 지원](repository-providers.md)을 따른다.
- 공급자 공식 SDK를 얇은 `LlmProvider` 인터페이스로 감싼다. 분석과 문장 생성을 분리해 공급자·모델을 설정으로 바꿀 수 있게 한다.
- 초기에는 JSON Schema 기반 출력을 지원하는 저비용 모델 한 개를 평가한다. 고성능 모델은 검증된 필요가 있는 건만 선택적으로 사용한다.
- 특정 모델의 가격·성능 순위는 이 문서에서 확정하지 않는다. 자체 표본의 품질·총비용·지연으로 결정한다.
- OpenAI를 선택한다면 Responses API와 Structured Outputs를 초기 어댑터 후보로 사용한다. 형식 준수와 사실 검증을 구분한다.
- 근거: [Octokit 공식 저장소](https://github.com/octokit/octokit.js), [OpenAI 구조화 출력](https://developers.openai.com/api/docs/guides/structured-outputs).

### UI·개발·배포

- React + Vite: 후보, 근거, 보충 질문, 최종 문장을 검토하는 UI. 검색 유입이나 SSR 요구가 없다는 MVP 가정에 따른 선택이다.
- pnpm workspace: CLI·API·워커·UI와 공통 모듈 관리. 초기에는 빌드 오케스트레이터를 추가하지 않는다.
- Vitest + 임시 PostgreSQL 통합 검증: 동기화·기간·중복·캐시·근거 규칙을 검증한다.
- Docker Compose: 로컬 PostgreSQL과 앱 실행 구성을 제공한다. 운영은 상시 실행 가능한 앱 프로세스와 관리형 PostgreSQL부터 검토한다.
- 문서 단계에서는 패키지를 설치하거나 배포하지 않는다. 구현 시 호환 버전을 확인하고 lockfile로 고정한다.

## 2. 대안과 트레이드오프

### TypeScript vs Python/FastAPI

TypeScript는 UI와 워커의 계약 공유, GitHub SDK 통합, 단일 언어 운영을 우선하는 선택이다. Python은 팀의 숙련도와 데이터 분석·ML 라이브러리 활용이 핵심이면 적합하다. 이 제품은 LLM 추론을 직접 실행하기보다 API로 호출하므로 Python 런타임을 추가할 필요성이 현재는 낮다. 어느 언어가 무조건 빠르다는 결론은 내리지 않는다.

### PostgreSQL vs SQLite

SQLite는 단일 PC·단일 프로세스 CLI만 만들 때 더 간단하다. PostgreSQL은 API·워커 분리, 동시 작업, 관계 조회와 큐를 같은 기반에서 처리하기 위한 선택이다. 본 제안은 CLI 검증 이후 웹 검토와 서비스 확장을 전제한다. 설치 없는 개인 CLI로 범위가 확정되면 SQLite + 단일 작업 실행기로 축소하는 편이 낫다.

### NestJS + Fastify vs Fastify 직접 사용

처음에는 작은 CLI에서 출발하는 범위로 Fastify 직접 사용을 제안했으나, 구조를 먼저 확립하고 기능을 확장하는 사용자 방향에 맞춰 NestJS를 선택했다. 모듈·DI·컨트롤러·테스트·종료 수명 주기의 기본 규칙을 재사용하는 이점과 데코레이터·프레임워크 규칙의 비용을 교환한다. NestJS 도입 자체가 LLM 토큰 절약이나 응답 속도를 보장하지 않는다.

### React/Vite vs Next.js

현재는 검토 앱이며 SEO·SSR 요구가 없다. UI는 React + Vite로 추가할 계획이다. Next.js 숙련도가 높거나 SSR이 필요해지면 UI 계층을 교체할 수 있다. 어떤 UI를 사용하든 수집과 분석은 요청 핸들러 밖의 작업으로 둔다.

### pg-boss vs Redis/BullMQ

처음에는 PostgreSQL 하나로 큐까지 운영해 구성 요소를 줄인다. 대신 DB 저장·조회와 큐가 자원을 공유한다. 큐 부하가 실제 업무 쿼리에 영향을 주거나 독립 확장이 필요할 때 Redis 기반 큐를 검토한다. PostgreSQL 큐가 모든 규모에서 더 빠르다는 주장은 하지 않는다.

### 직접 파이프라인 vs 에이전트 프레임워크

수집 → 검사 → 분석 → 사용자 확인 → 문장화 순서가 명확하다. 작은 상태 머신과 명시적 함수로 구현하면 호출 횟수·재시도·비용을 통제하기 쉽다. 자율 에이전트, 다중 토론, 범용 도구 실행은 MVP 요구가 생길 때 다시 판단한다.

### 관계·키워드 조회 vs 벡터 검색

첫 검색은 이슈 ID·PR 연결·저장소·기술 태그·기간으로 충분한지 확인한다. 영어·한국어 혼합 자료에서 기본 전문 검색 품질을 과신하지 않는다. 의미 기반 중복 탐지의 누락이 표본에서 확인되면 pgvector를 검토한다. 임베딩은 후보 제안에 쓰고 자동 성과 병합의 확정 근거로 삼지 않는다.

## 3. 처리 흐름

```text
Git 원격 / GitHub API·webhook / SourceCommit Git 연결
        ↓
증분 수집 → 원본 스냅샷 저장
        ↓
정규화·기여 확인·중복 제거·가역적 필터
        ↓
문제 해결 건 묶기 → 필요한 근거만 추가 수집
        ↓
근거 패킷 구성 → 변경된 건만 LLM 구조화 분석
        ↓
코드 검증 → 누락 질문 → 사용자 보충·승인
        ↓
기간별 구조화 기록 조회·선별 → LLM 한 문장 생성
        ↓
근거 검토·사용자 편집 → Markdown 출력

PostgreSQL: 원본 / 관계 / 분석 / 승인 / 작업 / 캐시 / 사용량
CLI·API·워커: 동일 도메인 로직 사용
```

## 4. 수집과 동기화

### 최초 수집

1. 저장소·공급자·연결 방식·조회 기간과 사용자 계정/커밋 이메일 매핑을 고정한다.
2. Git 경로에서는 커밋·ref·변경 파일 메타데이터를 찾고, GitHub API 경로에서는 기간에 활동했거나 완료된 PR·이슈를 메타데이터 중심으로 찾는다.
3. 목록 엔드포인트의 pagination을 끝까지 처리하고, 응답 한 페이지를 전체 이력으로 취급하지 않는다.
4. 후보의 연결 이슈·커밋·리뷰·변경 파일을 필요에 따라 가져온다. 문제 배경이 기간 이전이면 연결된 근거에 한해 확장한다.
5. PR을 통하지 않은 커밋과 PR이 없는 저장소도 처리한다. Git 수집의 증분·시간·이력 재작성 규칙은 [공급자 문서](repository-providers.md)를 따른다.

검색 API 결과를 완전한 원장으로 취급하지 않는다. 수집 범위, 완료한 페이지, 누락 가능성을 함께 기록한다. 리뷰·논의 기반 기여는 PR 작성자 필터만으로 찾지 않는다.

### 이후 수집

- 아래 API·webhook 규칙은 GitHub 어댑터에 적용한다. SourceCommit의 기본 증분 경로는 저장한 ref와 수집 OID를 대조하는 Git fetch이며, 같은 webhook/API 기능을 전제하지 않는다.
- 로컬 MVP는 수동 증분 동기화로 시작하고, 서비스 연결 시 GitHub App webhook을 추가한다.
- webhook은 변경 신호로 사용하고 API에서 현재 상태를 확인한다. 중복과 순서 뒤바뀜을 허용한다.
- 리소스 종류별 cursor와 완료 watermark를 저장하고, 성공한 범위만 전진시킨다.
- 엔드포인트가 `since`를 지원하면 겹치는 재수집 구간을 둔다. PR 목록처럼 없는 경우 `updated` 정렬을 활용하되 새 활동·댓글·리뷰 누락을 주기적 대조로 보완한다.
- ETag/Last-Modified 조건부 요청을 지원되는 응답에 적용한다.
- GitHub 요청은 인증 주체별 직렬 큐를 기본으로 한다. LLM 작업 병렬도와 별도로 제한한다.
- `Retry-After`, rate-limit reset, 지수 backoff와 jitter를 처리한다. SDK 재시도와 작업 재시도의 곱으로 호출이 폭증하지 않게 상한을 둔다.
- webhook 누락 복구를 위한 주기적 reconciliation을 둔다.

이 원칙은 [GitHub REST API 권장 사항](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)에 근거한다. 자주 polling하거나 무제한 병렬 요청을 보내는 구조를 피한다.

### 근거 불완전성

GitHub PR 파일 목록에는 최대 3,000개 파일 제한이 있다. 큰 PR, patch 누락, 이진 파일 등은 완전성 상태를 기록한다. 필요하면 제한된 범위의 Git fetch/diff로 보완하거나 사용자 확인 대상으로 둔다. Git 경로는 checkout 없는 로컬 bare 캐시를 사용하고 지원 여부를 확인한 범위에서 전송을 줄인다. 전체 작업 트리와 LFS 원본 다운로드를 기본으로 하지 않으며 저장소 코드를 실행하지 않는다. [PR 파일 API 문서](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files).

## 5. 논리 데이터 모델

- `connections`, `repositories`: 사용자·공급자·원격 인스턴스·연결·저장소 ID/URL・수집 방식・기능 지원 상태와 접근 범위. 개인용부터 모든 데이터에 소유자 경계를 둔다.
- `source_records`: 공급자·원본 종류·외부 ID·URL・작성자·발생/수정/수집 시각·Git OID·버전 hash·payload·완전성. 수정된 원본도 이전 버전을 남긴다. 커밋의 author/committer date와 관측·완료 시각을 구분한다.
- `sync_states`: 리소스별 cursor·watermark·ETag·최근 성공·실패와 누락 상태.
- `work_items`, `work_item_sources`: 문제 해결 건과 연결 근거, 관계 유형, 기여자, 진행·완료 상태.
- `evidence_packets`: 실제 LLM에 보낸 정제 근거, 발췌 위치·제외 사유·token 수·선별 버전.
- `analyses`, `claims`: 구조화 분석 버전과 주장별 상태·근거 ID·추정·누락.
- `user_confirmations`: 사용자 보충·수정·승인 및 적용한 분석 버전.
- `resume_snapshots`: 기간 절대 경계·기준 시간대·포함 작업/분석 버전·문장·사용자 편집본·최종 상태.
- `llm_runs`: 공급자·실제 모델·단계·입출력/캐시/추론 토큰·지연·비용·실패·예산.
- 작업 큐 스키마는 pg-boss가 관리한다. 도메인 작업 키와 결과 참조는 앱에서 유지한다.

소유자·공급자 인스턴스·저장소·원본 종류·외부 ID의 unique 제약, 기간 조회용 시간 인덱스, 작업-근거 연결 인덱스를 먼저 만든다. 공급자 간 숫자 ID나 서로 다른 저장소의 같은 OID를 무조건 합치지 않는다. JSONB 전체에 무조건 인덱스를 추가하지 않는다.

## 6. 작업과 실패 처리

- 작업 종류: `sync_repository`, `refresh_work_item`, `analyze_work_item`, `generate_resume`.
- 상태: queued → running → succeeded / retry_wait / failed / needs_input.
- 원본 저장과 후속 작업 등록은 가능한 한 같은 PostgreSQL 트랜잭션으로 묶는다.
- 작업 키: 소유자 + 단계 + 대상 + 입력/설정 hash. 동일 키의 실행을 직렬화하고 결과가 있으면 재사용한다.
- 외부 호출은 DB 트랜잭션 밖에서 수행한다. 실행 lease·heartbeat·복구 정책을 두고, 중간 실패한 결과를 성공으로 캐시하지 않는다.
- 타임아웃 직전에 공급자가 응답한 경우처럼 결과가 불명확하면 중복 호출 비용이 발생할 수 있다. 요청 ID를 남기고 공급자가 제공하는 멱등성·결과 조회 지원 범위에서 복구한다.
- 사용자에게는 작업 ID와 진행 상태를 제공한다. 초기 UI는 상태 조회로 시작하고 필요할 때 SSE를 추가한다.
- 워커 수를 늘리기 전에 큐 대기, DB 연결, GitHub 제한, LLM 제한을 측정한다.

## 7. 접근 및 데이터 경계

- GitHub 개인 검증은 저장소 범위를 제한한 읽기용 fine-grained PAT, 서비스는 GitHub App을 우선 검토한다. SourceCommit은 Git용 HTTPS 자격 증명 또는 SSH 키를 사용한다. Ncloud API 키와 Git 자격 증명은 구분하고 필요한 권한을 구현 시 확인한다.
- 인증 토큰과 공급자 키는 LLM 근거 패킷·로그·Markdown에 포함하지 않는다.
- 비공개 코드의 외부 LLM 전송 범위는 저장소별로 제어하고, 기본은 선별된 발췌다. 내부 전용 자료는 분석 대상에서 제외할 수 있어야 한다.
- webhook 서명 검증, delivery ID 중복 제거, 서버 측 소유권 확인을 적용한다.
- 원본·분석·캐시는 소유자/연결 경계로 격리한다. 권한 해제 후 결과 재조회에도 접근 정책을 적용한다.
- 원본 링크의 현재 상태와 과거 근거 스냅샷을 구분한다. 삭제·보존 정책은 파생 분석과 출력물까지 대상으로 한다.
- PR 본문·리뷰·코드는 신뢰할 수 없는 입력이다. 문서 속 명령을 실행하거나 LLM 도구 권한을 부여하지 않는다.

## 8. 확장 조건

- 원본 저장량과 백업 부담이 커지면 대용량 payload를 압축 object storage로 옮기고 DB에는 hash와 참조를 둔다.
- 큐 부하가 DB 업무 쿼리를 방해하면 큐 기반 분리를 검토한다.
- 관계·키워드 조회의 누락이 품질 평가에서 확인되면 임베딩 기반 후보 검색을 추가한다.
- CPU 분석이 병목으로 입증되면 별도 worker thread·프로세스 또는 전용 분석 런타임을 추가한다.
- 배포 수·데이터 크기·측정된 병목에 따라 분리하며, 예상만으로 마이크로서비스를 도입하지 않는다.
