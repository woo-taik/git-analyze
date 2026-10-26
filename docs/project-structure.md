# 프로젝트 구조와 개발 방법

기준일: 2026-10-26, Asia/Seoul. 현재 소스와 package 설정을 기준으로 작성했다.

## 1. 구조의 목적

GitHub·Ncloud SourceCommit 등 저장소별 차이는 수집 계층에서 처리하고, 검사·근거 분석·기간별 성과 생성은 공통 흐름으로 구성한다. CLI로 먼저 검증하고 같은 기능을 HTTP와 워커에서 사용하기 위한 pnpm 모노레포다.

실행과 의존성 조립은 `apps`, 재사용할 도메인 계약과 인프라 구현은 `packages`에 둔다. NestJS는 모듈·DI·수명 주기를, Fastify는 HTTP 어댑터를 담당한다. 토큰 절약은 입력 선별·증분 분석·캐시에서 처리한다.

## 2. 현재 디렉터리

```text
apps/
  api/src/
    index.ts                     HTTP listen·환경 설정·종료 hook
    app.ts                       Nest + Fastify 생성과 초기화
    app.module.ts                API 루트 모듈
    modules/
      health/                    생존·준비 상태 컨트롤러·모듈
      repositories/              공급자 카탈로그 컨트롤러·서비스·모듈
  cli/src/
    index.ts                     Nest standalone 진입점과 종료
    cli.module.ts
    command.service.ts           help·doctor·providers·collect·prepare·evidence 명령
    collect-options.ts           수집 옵션·경로 필터·KST 기간 계산
    history-report.ts            수집 Markdown·공용 JSON/Markdown 새 폴더 출력
    prepare.ts                   저장된 이력 입력 검증·후보 선별 조립
    candidate-report.ts          후보·검토·제외 Markdown과 원본 출처
    evidence.ts                  후보 입력·수동 묶기·근거 추출 조립·캐시·보고서
  worker/src/
    index.ts                     Nest standalone 진입점
    worker.module.ts
    worker.service.ts            작업 핸들러 조립·종료 수명 주기
    runner.ts                    pg-boss 실행·payload 구조 검증
  web/README.md                  검토 UI 후속 위치
packages/
  core/src/
    repositories.ts              공급자·기능 지원·커밋·수집기 계약
    evidence.ts                  근거·주장 상태·작업·분석·성과 문장
    llm.ts                       분석·문장 생성 계약과 토큰 사용량
    jobs.ts                      작업 이름과 payload
    prepare-candidates.ts        이메일·검토 사유·참조 묶기·수동 선별 규칙
    evidence-extraction.ts       로컬 근거 계약·발췌 우선순위·바이트 예산
    analysis-evidence.ts         분석 입력 변환·원본 매핑 검사·내용/입력 버전
    canonical-json.ts            추출·분석에 공통인 정규화 JSON 직렬화
    index.ts                     공개 export
  config/src/index.ts            환경 설정 검증과 기본값
  providers/src/
    catalog.ts                   공급자별 문서상 기능과 구현 상태
    git/local-history.ts         로컬 커밋·변경 파일 수집
    git/command.ts               shell 없는 Git 실행·출력 크기/시간 제한
    git/local-evidence.ts        객체 검증·첫 부모 raw diff·제한된 patch 읽기
    index.ts                     공개 export
  database/
    src/schema.ts                소유자·저장소·원본 버전 테이블
    src/index.ts                 DB 연결 factory와 종료 함수
    migrations/                  초기 SQL과 Drizzle metadata
    drizzle.config.ts            migration 생성·적용 설정
tests/scaffold.test.ts           API 경계·설정 비밀 값·워커 시작 검증
tests/collect.test.ts            실제 Git fixture·기간·출력·CLI 통합 검증
tests/prepare.test.ts            기여 구분·선별·묶기·오프라인 CLI 통합 검증
tests/evidence.test.ts           patch·제한·누락·캐시·실제 CLI 통합 검증
tests/analysis-evidence.test.ts  분석 입력의 출처·범위·해시·발췌 참조 검증
docs/                            요구사항·설계·구현 계획
package.json                     실행 명령·도구 버전
pnpm-workspace.yaml              workspace·의존성 빌드 정책
pnpm-lock.yaml                   고정한 의존성 해석 결과
tsconfig.base.json               strict ESM·데코레이터 공통 설정
tsconfig.json                    프로젝트 참조 기반 빌드 순서
vitest.config.ts                 테스트 검색 범위와 환경
compose.yaml                     로컬 PostgreSQL
.env.example                     개발 환경 설정 예시
```

실행 앱 3개와 공통 패키지 4개가 각각 `package.json`, `tsconfig.json`을 가진다. `apps/web`는 README만 있는 후속 위치이며 현재 workspace 패키지가 아니다. React·Vite는 아직 설치하지 않았다.

## 3. 앱의 역할과 실행 흐름

### API

[index.ts](../apps/api/src/index.ts)가 설정을 읽고 [app.ts](../apps/api/src/app.ts)로 앱을 생성한 뒤 포트를 연다. [AppModule](../apps/api/src/app.module.ts)은 `HealthModule`과 `RepositoriesModule`을 조립한다.

HTTP 요청은 컨트롤러에서 받고 필요한 서비스를 호출한다. 현재 `RepositoryCatalogService`는 공급자 카탈로그만 반환한다. 수집 작업 접수·저장소 등록·사용자 인증은 아직 없다.

현재 경로:

- `GET /health`: HTTP 프로세스 생존 상태, 200.
- `GET /ready`: 업무 파이프라인 미구현 상태, 503.
- `GET /v1/providers`: 공급자별 문서상 기능과 구현 상태.

### CLI

[CliModule](../apps/cli/src/cli.module.ts)을 Nest standalone context로 생성하고 [CommandService](../apps/cli/src/command.service.ts)를 실행한 뒤 컨텍스트를 닫는다. HTTP 포트는 열지 않는다.

- `help`: 사용법.
- `doctor`: Node·Git 실행 여부와 DB 설정 유무. DB 접속 검사는 수행하지 않는다.
- `providers`: 공급자 카탈로그. 실제 연결 성공을 의미하지 않는다.
- `collect`: 로컬 레포와 기간을 검증하고 이력을 수집해 JSON·Markdown 파일을 생성한다. DB와 LLM을 사용하지 않는다.
- `prepare`: 저장한 `history.json`과 작성자 이메일/별칭으로 후보·검토·제외를 선별하고 JSON·Markdown을 생성한다. Git·DB·LLM에 연결하지 않는다.
- `evidence`: 저장한 후보에서 그룹 하나 또는 명시한 커밋들을 선택하고, 로컬 객체 검증 후 크기를 제한한 patch 근거와 추출 캐시를 생성한다. DB·LLM을 사용하지 않는다.

호출 흐름은 `CommandService → parseCollectOptions → collectLocalHistory → writeHistoryReports`다. `--repo`는 필수이며 `--period`는 `1w`·`1m`·`3m`·`6m`, `--ref`는 기본 `HEAD`다. `--path`는 Git 저장소 루트 기준 상대 경로를 지정하고, `--output`은 새 출력 폴더를 지정한다.

후보 선별 흐름은 `CommandService → executePrepare → prepareCandidates → writeCandidateReports → writeReportPair`다. `prepare.ts`가 JSON schema·날짜 범위·OID·파일 상태·입력 상한을 검사하고, core가 외부 연결 없이 규칙을 적용한다. `--input`, `--author`는 필수이며 `--alias`와 `--author`를 반복해 명시적으로 동일인 이메일을 선택한다. `--include`/`--exclude`는 전체 OID로 재선별한다. 출력마다 새 폴더를 만들어 원본과 기존 결과를 보존한다.

근거 추출 흐름은 `CommandService → executeEvidence → inspectLocalEvidence → 캐시 조회 또는 buildLocalEvidence/readLocalPatch → writeReportPair`다. 후보의 원본을 기존 history parser로 검증하고, 저장된 명시적 override로 규칙을 다시 계산한다. `--group`과 반복 `--commit`은 상호 배타적이며 최대 20커밋을 선택한다. runtime 입력 검증과 파일 I/O는 CLI, 선택·예산 정책은 core, Git 객체·patch 읽기는 providers가 담당한다.

캐시 재사용 전에도 원본 메타데이터·ref 기준 도달 가능성·파일 목록·blob 존재를 확인한다. 추출 키와 패킷 내용 hash는 별도다. 실행/관측 시각·출력 경로·기간은 패킷 내용에 넣지 않고 보고서의 출처 정보로 둔다. 서로 다른 clone은 별도 범위이며 로컬 범위 식별은 HTTP 인증·인가를 대신하지 않는다.

### 워커

[WorkerModule](../apps/worker/src/worker.module.ts)이 [WorkerService](../apps/worker/src/worker.service.ts)를 구성한다. 서비스가 핸들러를 조립하고 [runner.ts](../apps/worker/src/runner.ts)가 pg-boss의 시작·큐 등록·payload 구조 검증을 담당한다. 종료 시 Nest 수명 주기로 큐를 정리한다.

계획된 작업 이름은 `sync_repository`, `refresh_work_item`, `analyze_work_item`, `generate_resume`다. 현재 실제 업무 핸들러는 없으며 일반 시작은 실패한다. `worker:check`는 설정과 예정된 큐만 출력한다. 빈 핸들러로 작업을 성공 처리하지 않는다.

## 4. 공통 패키지의 역할

### core

프레임워크와 공급자에 독립적인 타입·상수·포트를 둔다. Nest·DB·공급자 SDK에 대한 런타임 의존성이 없다.

- `RepositoryReader`: 저장소 기능 확인·커밋·diff 수집 계약.
- `CommitRecord`: 작성·커미터·관측 시각을 구분하는 커밋 기록.
- `EvidencePacket`, `EvidenceReference`: 분석할 발췌와 원본 ID·버전·위치.
- `Claim`: 원본 지지·사용자 확인·추정·누락을 구분하는 주장.
- `WorkItem`, `WorkItemAnalysis`, `ResumeBullet`: 문제 해결 건·분석·성과 문장.
- `LlmProvider`, `LlmUsage`: 분석·생성 계약과 토큰 사용량.
- `JobPayload`: 작업의 소유자·저장소·대상·입력 버전.
- `prepareCandidates`: 순수 함수로 이메일 정규화·동일 OID 중복 제거·기여 기록 구분·검토 사유·명시적 참조 묶기·수동 선별을 계산한다. 입력·원본·선별 사유를 보존하며 `candidates-v1` 규칙 버전을 출력한다.
- `LocalEvidencePacket`, `buildLocalEvidence`: 커밋 메시지·파일 근거 ID·첫 부모 patch 위치·생략 사유·완전성을 기록한다. 읽기 콜백을 주입받고 파일/전체 바이트·파일 수 예산을 적용한다. Node 파일 시스템·해시·Git 실행에 직접 의존하지 않는다.
- `toEvidencePacket`: 타입이 검증된 로컬 추출 패킷을 분석 입력으로 변환한다. Web Crypto SHA-256으로 내용 버전을 대조하며 외부 연결·파일 I/O·DB 조회를 수행하지 않는다.

작성자 일치는 후보, 공동 작성 trailer와 커미터만 일치는 검토, 미일치는 제외다. 병합·생성 경로만 변경·여러 참조 등은 검토에 남기며 자동으로 성과를 확정하지 않는다. 단일 명시적 이슈 참조가 같은 경우에만 같은 상태 안에서 묶는다. 참조가 없으면 커밋별 후보로 유지한다. 수동 포함도 기여 구분을 덮어쓰지 않는다. 후보 묶음은 영속 `WorkItem`·승인 기록·내용 hash 캐시가 아니다.

인터페이스와 타입 선언은 실제 수집기나 LLM 연결이 구현됐다는 뜻이 아니다.

`LocalEvidencePacket`은 로컬 CLI의 추출 형식이다. `toEvidencePacket`은 호출자가 전달한 `ownerId`, `repositoryId`, `workItemId`와 커밋별 `EvidenceSourceBinding`으로 `EvidencePacket`을 만든다. 원본 매핑에는 `commitOid`, `sourceRecordId`, `sourceVersion`, 소유자·저장소 범위가 필요하다. 선택 커밋마다 원본 레코드를 하나씩 명시해야 하며 누락·중복·다른 범위는 거부한다. DB 레코드를 자동 생성하거나 로컬 Git 디렉터리 hash를 영속 저장소 ID로 취급하지 않는다. 범위 일치 검사는 인증·인가나 DB 레코드 존재 확인을 대신하지 않는다.

```ts
import { toEvidencePacket } from '@git-analyze/core';

// report는 I/O 경계에서 파싱·검증한 evidence 보고서,
// sourceBindings는 호출 계층에서 확인한 커밋별 원본 스냅샷 연결이다.
const input = await toEvidencePacket({
  ownerId, repositoryId, workItemId,
  packet: report.packet,
  contentVersion: report.contentVersion,
  sources: sourceBindings,
});
```

`provenance.contentVersion`은 기존 추출 패킷의 정규화 SHA-256이며 변환 전에 재계산해 비교한다. `version`은 소유자·저장소·작업 ID, 원본 매핑, 변환 규칙 버전과 보존된 근거 전체를 포함한 분석 입력 SHA-256이다. 같은 추출 내용이라도 원본 버전·작업·범위가 바뀌면 분석 입력 버전이 바뀐다. 원본 매핑 배열은 커밋 순서로 정규화하므로 전달 순서만 바뀌어도 결과가 달라지지 않는다. 모델·프롬프트·사용자 확인 버전 등을 포함한 분석 결과 캐시 키는 후속 구현이다.

발췌의 `id`, 텍스트, locator, 커밋/부모 OID, 경로와 `complete`를 보존하고 `reference`에 원본 레코드 ID·버전을 연결한다. `provenance.local`에는 추출 정책·명시적 묶기·선별/기여 정보·파일 manifest·blob OID·생략 사유·요약을 보존한다. 실행 시각·로컬 절대 경로·캐시 hit 등 보고서 실행 메타데이터는 포함하지 않는다. 입력 객체는 복사하므로 변환 중·후 원본의 변경이 반환값을 수정하지 않는다.

현재 변환기는 지원 추출 버전, 내용 hash, 선택/원본/발췌 연결의 일관성을 검사한다. 저장된 임의 JSON의 전체 런타임 스키마 검증기는 아니므로 입력 파싱·크기 제한은 추후 `analyze` CLI의 I/O 경계에서 처리해야 한다. 추출 완전성을 분석 근거의 의미적 충분성으로 해석하지 않으며 후보 상태·기여 분류를 승인하거나 완료일을 부여하지 않는다. 이 함수는 아직 CLI·DB·LLM 실행 흐름에 연결하지 않았다.

### config

[loadConfig](../packages/config/src/index.ts)는 설정을 검증하는 함수다. import할 때 파일을 읽거나 외부 연결을 만들지 않는다. 루트 실행 명령의 Node env-file 옵션이 `.env`를 읽고, 함수가 `process.env`를 해석한다.

설정은 `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`이다. 기본 HTTP 주소는 `127.0.0.1:3000`이고 DB URL은 선택 사항이다. DB 설정 유무와 실제 접속 가능 여부는 구분한다.

### providers

GitHub·SourceCommit·일반 Git 원격·로컬 저장소의 카탈로그와 로컬 이력 수집을 제공한다. 문서상 capability와 구현 상태를 구분한다. 현재 `local`은 `implemented`, 원격 어댑터는 `planned`다.

`git/local-history.ts`는 ref를 OID로 고정하고 커미터 날짜의 `[start, end)` 범위로 커밋을 선택한다. NUL 구분자를 사용해 여러 줄 메시지와 한글·공백 파일명을 읽는다. 변경 파일은 첫 부모와 비교하며 이름 변경 탐지는 끈다. shallow 이력과 1,000건 초과는 조용히 잘라내지 않고 거부한다.

`--path frontend`는 diff의 경로 범위만 제한하고 변경 파일이 없는 커밋을 제외한다. 따라서 부모 관계와 메시지는 유지되고, 출력 파일 목록에는 해당 경로만 남는다. Git 경로는 리터럴로 해석해 `frontend-backup`이나 glob 패턴을 잘못 포함하지 않는다. 1,000건 상한은 경로 필터 전 기간 내 검사 대상에 적용한다.

`git/command.ts`는 두 수집 흐름이 공유한다. stdout을 바이트 단위로 제한해 prefix만 보관하고 상한/30초 타임아웃에 프로세스를 종료한다. ambient `GIT_*` 환경은 제거하고 네트워크·lazy fetch·외부 diff·textconv를 사용하지 않는다.

`git/local-evidence.ts`는 실제 객체와 저장된 메타데이터를 대조하고 root/첫 부모 raw diff를 읽는다. NUL·비 UTF-8·submodule을 구분하며 Node 프로세스에 blob 전체를 적재하지 않는다. patch의 hunk 위치는 유지하고 속성에 의존하는 함수명 suffix는 제거한다. Git 버전·설정·유효 속성도 캐시 식별에 반영한다. 옵션 의미는 [Git diff 문서](https://git-scm.com/docs/git-diff), 로컬 공통 디렉터리는 [Git rev-parse 문서](https://git-scm.com/docs/git-rev-parse)를 참고한다.

현재는 전체 `RepositoryReader` 어댑터가 아닌 로컬 기간 수집·patch 추출 함수다. 원격 Git 수집과 `github/`, `sourcecommit/` API 보강 모듈은 후속 작업이다.

### database

Drizzle schema와 지연 연결 pool factory를 제공한다. import만으로 연결하거나 migration을 적용하지 않는다. pool 사용자는 반환된 `close()`를 실행 계층의 종료 수명 주기에 연결한다.

현재 테이블:

- `owners`: 데이터 소유자.
- `repositories`: 소유자·공급자·인스턴스·외부 ID로 식별하는 저장소와 자격 증명 참조.
- `source_records`: 원본 종류·외부 ID·내용 버전·발생/관측 시각·payload.

복합 외래 키로 다른 소유자의 저장소에 원본을 연결하지 못하게 한다. 이 제약이 HTTP 인증·인가를 대신하지는 않는다. 분석·승인·이력서 결과·캐시 테이블은 아직 없다.

## 5. 의존성 방향과 기능 추가 규칙

```text
API    → config, providers → core
CLI    → config, core, providers → core
Worker → config, core, pg-boss
Database → core, Drizzle, pg

core → 앱·Nest·DB·공급자 SDK에 의존하지 않음
```

- 앱끼리 내부 서비스를 직접 import하지 않는다.
- 공통 도메인 타입·포트는 `core`, 통신·정규화는 `providers`, 영속화는 `database`에 둔다.
- HTTP·CLI·큐 입력과 Nest DI 조립은 해당 앱이 담당한다.
- 앱 둘 이상에서 사용할 유스케이스가 생기면 공유 패키지로 분리한다. 도메인 계약 안에 네트워크 호출을 섞지 않는다.
- 수집·분석·이력서 API는 실제 기능이 구현될 때 Nest 기능 모듈로 추가한다.
- 소유권·입력 버전·멱등성 검사는 실제 유스케이스에서 수행해야 한다.

DB는 아직 앱에 연결하지 않았다. 실제 기능을 추가할 때 Nest provider로 조립한다. 현재 의존성 방향은 코드와 workspace 설정으로 표현되어 있으며 별도의 금지 import lint 규칙은 없다.

## 6. 개발 환경과 실행

Node 24·pnpm 11·Git CLI를 사용한다. 모든 명령은 프로젝트 루트에서 실행한다. DB 실행에는 PostgreSQL 또는 Docker가 추가로 필요하다.

```sh
pnpm install --frozen-lockfile
pnpm cli help
pnpm cli doctor
pnpm cli providers
pnpm cli collect --repo "C:\dev\git-analyze" --period 1w
pnpm cli collect --repo "C:\dev\law" --period 1w --path frontend
pnpm cli prepare --input ".data\my-history\history.json" --author "me@example.com" --alias "work@example.com"
pnpm cli evidence --input ".data\my-candidates\candidates.json" --commit <전체 OID>
pnpm worker:check
pnpm dev:api
```

설정이 필요하면 `.env.example`을 `.env`로 복사한다. Windows PowerShell에서는 파일이 아직 없을 때 `Copy-Item .env.example .env`를 사용한다. 기존 설정 파일은 보존한다. 기본 API와 진단은 `.env` 없이 실행할 수 있다.

`dev:api`는 tsx와 `development` export 조건으로 workspace 소스를 직접 실행한다. Nest 생성자 주입에는 `@Inject` 토큰을 명시해 소스 실행기의 metadata 생성에 의존하지 않는다.

## 7. 빌드와 검증

```sh
pnpm build
pnpm typecheck
pnpm check
pnpm start:api
```

- `build`와 `typecheck`는 모두 `tsc -b`다. 프로젝트 참조 순서로 소스 타입을 확인하고 산출물을 생성한다.
- 상대 import는 `.js` 확장자를 사용하고 배포 빌드는 NodeNext ESM으로 생성한다.
- 공통 패키지 export는 개발 조건에서 `src`, 기본 실행에서 `dist`를 가리킨다.
- `start:api`, `start:worker`는 `dist`를 사용하므로 먼저 빌드해야 한다.
- `build:watch`는 산출물의 변경 빌드를 계속 실행한다.
- 별도 Nest CLI·번들러·빌드 오케스트레이터는 아직 도입하지 않았다.
- `check`는 빌드 후 Vitest를 실행한다.

기본 테스트 다섯 개는 생존/준비 상태 구분, 공급자의 문서상 기능/미구현 상태 구분, 미구현 HTTP 수집 요청 거부, 설정 오류의 비밀 값 비노출, 핸들러 없는 워커의 연결 전 거부를 확인한다.

Git 통합 테스트는 임시 저장소에서 기간 경계·KST 월말·과거 날짜의 자식 커밋·root와 merge·rename·한글 경로·작업 트리 보존·shallow 거부·출력 덮어쓰기 방지·빌드된 CLI 실행을 확인한다. 외부 GitHub·SourceCommit 연결, LLM 품질, PostgreSQL 쿼리와 운영 성능은 검증하지 않는다.

경로 필터 테스트는 혼합 커밋에서 대상 파일만 남기기, 다른 폴더 전용 커밋 제외, 유사한 폴더명 제외, 경로 밖으로 이동한 파일의 삭제 기록, merge 포함, 특수문자 경로의 리터럴 처리, 경로 정규화·이탈 거부와 실제 CLI 전달을 확인한다.

후보 선별 테스트는 작성자/커미터/공동 작성 구분, 명시적 별칭만 매핑, 병합·낮은 우선순위·빈 변경 검토, 참조별 묶기와 중복 그룹 방지, 수동 재선별·원본 보존, 중복 관측과 내용 충돌, 잘못된 입력 거부를 확인한다. 실제 레포가 없는 경로를 담은 fixture로 빌드된 Nest CLI를 실행해 오프라인 동작, Markdown escape, 원본 바이트 보존과 출력 덮어쓰기 방지를 검증한다.

근거 테스트는 실제 Git fixture에서 root·첫 부모 merge·삭제/이름 변경·한글/특수 경로·이진 파일·submodule, 파일/전체 바이트·파일 수 제한, 저우선순위 포함, 명시적 묶기와 CLI 실행을 확인한다. 캐시는 출력/관측 시각 변경 시 재사용, 정책·Git 설정·경로·clone 변경 시 분리, 손상 캐시 복구, 위조 메타데이터 거부와 캐시 이후 blob 누락 시 재사용 거부를 검사한다.

분석 입력 테스트는 발췌·기여·생략 정보 보존, 원본 매핑과 소유자·저장소 범위, 내용 hash와 분석 입력 버전, 끊어진 참조 거부, 입력 복사, 불완전한 근거 보존을 확인한다. 실제 `evidence` 보고서의 복수 커밋을 변환한 뒤 원래 추출 패킷으로 복원하는 연결 테스트도 포함한다.

## 8. DB와 migration

`.env`의 `DATABASE_URL`을 설정하고, 로컬 Docker를 사용할 경우 다음 순서로 실행한다.

```sh
pnpm db:up
pnpm db:migrate
pnpm db:down
```

최초 실행은 저장된 migration을 적용하면 된다. schema를 변경했을 때 `pnpm db:generate`로 새 SQL과 metadata를 생성하고 검토한 뒤 적용한다. 생성 SQL과 metadata는 함께 버전 관리하고, migration을 서버 시작 시 자동 실행하지 않는다.

Compose의 고정 자격 증명과 localhost 바인딩은 로컬 개발용이다. `db:down`은 volume을 삭제하지 않는다. SQL 생성과 실제 DB 적용은 별도 검증 단계다.

## 9. 현재 구현 범위

완료: workspace·lockfile, Nest 모듈과 독립 실행 골격, strict TypeScript 설정, 기본 API, CLI 진단·로컬 Git 수집·기간 선택·JSON/Markdown 출력, 이메일/별칭 기반 후보 선별·참조 묶기·수동 포함/제외, 수동 커밋 묶기·제한된 근거 추출·추출 캐시, 분석 입력 변환·출처 연결·내용/입력 버전 검사, 공급자 카탈로그, 수집/LLM 계약, pg-boss runner, 초기 DB schema·SQL, 기본·Git·후보·근거·분석 입력 테스트.

미구현: 원격 Git 동기화·GitHub API·SourceCommit 인증 연결·LLM 호출·LLM 분석 캐시·이력서 생성·인증과 소유권 검사·검토 UI. `collect`는 원본 메타데이터, `prepare`는 분석 대상, `evidence`는 선택된 변경 근거를 제공한다. 실제 기여 범위 확정·문제 해결 판단·업무 완료 판단은 수행하지 않는다.

## 10. 관련 문서

- [제품 요구사항](product-requirements.md): 분석 단위와 기간·근거 규칙.
- [아키텍처](architecture.md): 기술 선택과 수집·저장·작업 처리 원칙.
- [저장소 공급자](repository-providers.md): GitHub·SourceCommit의 수집 범위와 한계.
- [LLM 효율 설계](llm-efficiency.md): 입력 선별·분석 재사용·캐시와 예산.
- [구현 계획](implementation-plan.md): 첫 수직 경로와 후속 단계.
