# Git Analyze

GitHub·Ncloud SourceCommit 등 Git 저장소의 활동을 근거로 기술적 문제 해결 과정을 분석하고, 기간별 이력서 성과 문장을 생성하는 프로젝트.

## 핵심 원칙

- 커밋 개수가 아니라 문제 해결 건을 분석한다.
- 문제와 제약 → 대안 비교 및 선택 이유 → 구현 → 결과와 검증을 기록한다.
- 결과는 성과별 한 문장으로 제공하고, 상세 설명과 원본 근거를 연결한다.
- 1주일·1개월·3개월·6개월 결과는 같은 구조화 기록을 재사용한다.
- LLM은 선별된 근거의 해석과 문장화에 사용한다. 수집·중복 제거·필터링·집계는 코드로 처리한다.
- 확인되지 않은 성능 수치, 비즈니스 효과, 본인 기여, 트레이드오프를 만들어내지 않는다.

## 문서

- [제품 요구사항](docs/product-requirements.md): 분석 단위, 성과의 근거, 기간 규칙, MVP 범위.
- [기술 스택 및 아키텍처](docs/architecture.md): 권장 구성, 대안 비교, 수집·저장·작업 처리 설계.
- [LLM 비용 및 토큰 설계](docs/llm-efficiency.md): 재사용, 입력 예산, 캐시, 품질 평가와 비용 측정.
- [구현 순서](docs/implementation-plan.md): 단계별 산출물과 완료 조건.
- [다중 저장소 공급자 지원](docs/repository-providers.md): 공통 Git 수집, GitHub·SourceCommit 연결, 추적 가능 범위와 한계.
- [프로젝트 구조와 개발 방법](docs/project-structure.md): 전체 디렉터리, 앱·패키지 책임, 의존성 방향, 기능 추가 규칙, 실행·검증·DB 관리와 구현 범위.

## 기술 스택

TypeScript / Node.js 24 LTS / NestJS + Fastify 어댑터 / PostgreSQL / Drizzle / pg-boss.
API는 Nest HTTP 앱, CLI와 워커는 Nest 독립 실행 컨텍스트로 구성한다. 공통 도메인과 수집·LLM 계약은 Nest 의존성 없이 유지한다.

Git CLI 기반 수집과 Octokit 보강, React + Vite 검토 UI, 실제 LLM 어댑터는 후속 구현이다.

## 시작

Node.js 24와 pnpm 11이 필요하다. 루트에서 실행한다.

```sh
pnpm install --frozen-lockfile
pnpm cli doctor
pnpm dev:api
```

설정을 바꾸려면 `.env.example`을 `.env`로 복사한다. `.env` 없이도 CLI 진단과 기본 API는 실행된다.

- `GET /health`: 프로세스 생존 확인.
- `GET /ready`: 업무 파이프라인 미구현 상태이므로 현재 503을 반환.
- `GET /v1/providers`: 공급자별 문서상 기능과 구현 예정 상태.

```sh
pnpm check
pnpm worker:check
pnpm build
pnpm start:api
```

DB가 필요할 때 Docker 환경에서 `pnpm db:up`, `.env` 설정 후 `pnpm db:migrate`를 실행한다. 생성 SQL은 `packages/database/migrations`에 있다.

현재 완료: 모노레포, Nest 실행 골격, 공통 계약, 공급자 카탈로그, 초기 DB schema/migration, 기본 검증.
미구현: 실제 이력 수집·LLM 분석·기간 계산·성과 생성·UI. 워커는 실제 핸들러 연결 전까지 일반 시작을 거부하며 `worker:check`로만 골격을 확인한다.

작성 기준일: 2026-10-20, Asia/Seoul.
