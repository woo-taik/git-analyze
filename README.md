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

로컬 Git 이력 수집, 작성자별 후보 선별, 선택한 후보의 코드 변경 근거 추출은 CLI에서 실행할 수 있다. 원격 fetch·clone, Octokit 보강, React + Vite 검토 UI, 실제 LLM 어댑터는 후속 구현이다.

## 시작

Node.js 24와 pnpm 11이 필요하다. 루트에서 실행한다.

```sh
pnpm install --frozen-lockfile
pnpm cli doctor
pnpm cli collect --repo "C:\dev\git-analyze" --period 1w
pnpm dev:api
```

설정을 바꾸려면 `.env.example`을 `.env`로 복사한다. `.env` 없이도 CLI 진단과 기본 API는 실행된다.

## 특정 로컬 레포 수집

```powershell
pnpm cli collect --repo "C:\dev\대상레포" --period 1w
pnpm cli collect --repo "C:\dev\대상레포" --period 1m --ref main --output ".data\my-history"
pnpm cli collect --repo "C:\dev\law" --period 1w --path frontend
```

- `--repo`: 이미 로컬에 있는 Git 저장소 경로. GitHub·SourceCommit에서 clone한 레포 모두 가능하다.
- `--period`: `1w`(기본), `1m`, `3m`, `6m`. Asia/Seoul 기준 과거 구간이며 월말을 보정한다.
- `--ref`: 기본 `HEAD`. 지정한 ref에서 도달 가능한 모든 작성자의 커밋을 수집한다.
- `--path`: Git 저장소 루트 기준 상대 경로. `frontend`면 해당 폴더를 변경한 커밋만 남기고 파일 목록도 `frontend/`로 제한한다. 경로를 생략하거나 `.`을 주면 전체 저장소다.
- `--output`: 새 출력 폴더. 생략하면 `.data/collections/<실행별 ID>`에 저장한다. 기존 폴더는 덮어쓰지 않는다.

결과는 `history.json`과 `history.md`다. 커미터 날짜의 `[시작, 종료)`로 선택하고 작성자·메시지·변경 파일을 담는다. 병합 변경은 첫 부모와 비교하며 이름 변경은 삭제·추가로 기록한다.

`--repo "C:\dev\law\frontend"`를 입력해도 저장소 루트는 `C:\dev\law`다. 따라서 frontend만 원하면 `--path frontend`를 함께 지정한다. 경로는 글자 그대로 처리하며 절대 경로와 `..`은 허용하지 않는다. 삭제된 파일·폴더도 과거 이력에서 찾을 수 있다. 혼합 커밋의 메시지는 원문을 유지하고 파일 목록만 제한한다.

DB·LLM 키 없이 실행한다. `collect`는 checkout·fetch·원격 접속·patch 수집·작성자 필터를 수행하지 않는다. 빈 저장소나 존재하지 않는 ref, shallow 이력, 경로 필터 전 기간 내 검사 대상 1,000건 초과는 오류로 알린다. 수집 결과는 이력서 성과 분석 전의 원본 기록이다.

## 본인 이력에서 분석 후보 선별

```powershell
pnpm cli prepare --input ".data\my-history\history.json" --author "me@example.com"
pnpm cli prepare --input ".data\my-history\history.json" --author "me@example.com" --alias "work@example.com" --output ".data\my-candidates"
```

먼저 `collect --output ".data\my-history"`로 저장한 파일을 입력한다. `prepare`는 저장된 JSON만 읽으므로 원본 레포·Git·DB·LLM 연결 없이 반복 실행할 수 있다. `--author`와 `--alias`는 여러 번 지정할 수 있다. 이메일은 대소문자와 앞뒤 공백만 정규화하며 이름·유사 이메일로 동일인을 추정하지 않는다.

- 작성자 일치는 분석 후보, 커미터만 일치하거나 공동 작성 trailer가 있으면 검토 필요로 분류한다.
- 병합·lockfile/생성 경로만 변경·변경 파일 없음·여러 이슈 참조는 검토에 남긴다. 변경 크기나 파일명만으로 영구 제외하지 않는다.
- 명시적 `APP-123`, `fixes #123`, `refs #123` 등 단일 참조가 같을 때만 같은 상태 안에서 묶는다. 제목·시간·경로 유사도와 단독 `#123`은 묶기 기준이 아니다. 참조 존재·같은 문제 여부는 아직 검증하지 않는다.
- 일치하지 않는 작성자는 제외 상태로 기록하며 원본 커밋·파일·선별 사유를 JSON에 보존한다.
- `--include <전체 OID>` 또는 `--exclude <전체 OID>`를 반복 지정해 다시 선별할 수 있다. 수동 포함은 본인 기여·업무 완료를 확인했다는 뜻이 아니다. 같은 OID의 상충 지시나 입력에 없는 OID는 거부한다.

출력은 `.data/candidates/<실행별 ID>/candidates.json`과 `candidates.md`다. `--output`은 새 폴더만 허용한다. JSON에는 원본 경로·ref·기준 OID·기간·선택 이메일·규칙 버전·모든 원본 커밋과 선별 결과를, Markdown에는 후보·검토·제외 목록을 남긴다. 같은 OID의 반복 관측은 중복 제거하되 내용 충돌은 오류로 알린다.

입력은 수집기 schema v1, 최대 1,000개 커밋·32 MiB의 JSON이다. 원본 파일을 수정하지 않는다. 후보는 향후 patch·근거 검토를 위한 입력이며 이력서 성과 문장이 아니다. 현재 선별 단계의 LLM 호출은 0회이며, 분석 캐시와 토큰 예산 적용은 후속 작업이다. 전체 보존용 JSON을 그대로 LLM에 전달하는 구조는 구현하지 않았다.

## 선택한 후보의 코드 변경 근거 추출

```powershell
pnpm cli evidence --input ".data\my-candidates\candidates.json" --group "candidate:commit:<전체 OID>"
pnpm cli evidence --input ".data\my-candidates\candidates.json" --commit <전체 OID>
pnpm cli evidence --input ".data\my-candidates\candidates.json" --commit <첫 OID> --commit <다음 OID> --title "검색 결과 처리 개선"
```

`--group`과 반복 가능한 `--commit` 중 하나를 지정한다. 후보의 group ID는 `candidates.json`의 `groups[].id`에 있다. 한 패킷에서 최대 20개 커밋을 선택할 수 있다. 명시적으로 여러 커밋을 선택하면 수동 묶음으로 기록하며 같은 문제라고 자동 확정하지 않는다. 제외된 커밋은 먼저 `prepare --include <전체 OID>`로 재선별해야 한다.

저장된 OID·부모·작성자/커미터·시각·메시지가 실제 로컬 객체와 일치하는지 확인하고, 저장된 경로 범위에서 첫 부모 대비 patch를 수집한다. 최초 커밋은 빈 트리 대비, 이름 변경은 삭제·추가로 기록한다. 복수 커밋은 커밋별 patch를 유지하며 최종 상태의 합산 diff를 만들지 않는다. `--repo`로 같은 객체가 있는 다른 로컬 clone 경로를 지정할 수 있다. checkout·fetch·LLM 호출은 수행하지 않는다.

- 기본 한도: 파일당 16,384바이트, 메시지와 patch 발췌 본문 합계 65,536바이트, 최대 20파일. 메시지는 커밋당 최대 4,096바이트다.
- `--max-file-bytes`, `--max-total-bytes`, `--max-files`로 변경한다. 허용 최대치는 각각 262,144바이트, 1,048,576바이트, 100파일이다. JSON 메타데이터 크기나 모델 토큰 상한은 아니다.
- lockfile·생성 경로는 기본 생략하고 사유를 남긴다. `--include-low-priority`로 포함할 수 있다. 일반 파일을 먼저 처리한다.
- NUL이 탐지된 이진 파일, UTF-8로 해석할 수 없는 파일, submodule은 본문을 생략한다. 이진 탐지는 각 이전/이후 blob의 첫 8,000바이트 NUL 검사이므로 모든 파일 형식을 식별하는 기능은 아니다.
- 큰 patch는 UTF-8의 완전한 줄까지만 남긴다. 파일·전체 예산, 파일 수 상한, 이진 파일, 객체 누락 등 이유를 기록하고 `complete: false`로 표시한다. 잘린 patch는 적용용 파일이 아니다.

출력은 `.data/evidence/<실행별 ID>/evidence.json`·`evidence.md`다. `--output`은 새 폴더를 지정한다. 근거별 커밋·부모 OID, 파일 경로, blob OID, 정규화한 patch의 줄 위치와 hunk 헤더를 보존한다. `complete`는 선택한 커밋·경로의 추출 범위에만 해당하며 문제 설명·업무 완료·테스트 성공을 뜻하지 않는다.

추출 캐시는 `.cache/evidence`에 저장한다. `--cache-dir`로 위치를 지정하거나 `--no-cache`로 읽기·쓰기를 끌 수 있다. 캐시 hit에도 실제 커밋·파일 목록·blob 존재를 검사하며 patch 재추출을 생략한다. 객체가 없거나 조회에 실패한 결과는 캐시하지 않는다. 한도 때문에 일부만 담은 패킷은 불완전 표시와 함께 재사용할 수 있다.

캐시 키는 로컬 Git 공통 디렉터리의 식별 hash, Git 버전, 설정·유효 속성 hash, 선택 커밋·기여 분류·경로 범위·추출 규칙·한도·수동 묶기 정보를 포함한다. 출력 위치·실행 시각·관측 시각·기간만 바뀌어도 같은 입력이면 재사용한다. clone이 달라지면 별도 범위로, 같은 공통 Git 디렉터리를 쓰는 worktree는 같은 범위로 취급한다. Git 설정 원문은 캐시에 저장하지 않는다. 정규화한 패킷의 SHA-256을 `contentVersion`으로 반환한다. LLM 분석 결과 캐시는 아직 없다.

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

현재 완료: 모노레포, Nest 실행 골격, 공통 계약, 공급자 카탈로그, 로컬 Git 수집·기간 선택·JSON/Markdown 출력, 이메일·별칭 기반 후보 선별·참조별 묶기·수동 포함/제외, 선택 커밋의 크기 제한 근거 추출·추출 캐시·수동 묶기, 분석 입력 변환·원본 매핑·내용/입력 버전 검사, 초기 DB schema/migration, 기본·Git·후보·근거·분석 입력 테스트.
미구현: 원격 동기화·LLM 분석·성과 생성·UI. 워커는 실제 핸들러 연결 전까지 일반 시작을 거부하며 `worker:check`로만 골격을 확인한다.

분석 입력 변환은 core의 `toEvidencePacket`으로 제공한다. 호출자가 명시한 소유자·저장소·작업과 커밋별 원본 스냅샷을 연결하며, 근거 ID·기여·생략 사유를 보존한다. 추출 내용 버전을 검증하고 매핑을 포함한 별도 분석 입력 버전을 계산한다. 아직 CLI·DB·LLM에는 연결하지 않았다. 사용 계약은 [프로젝트 구조](docs/project-structure.md)의 core 설명을 따른다.

작성 기준일: 2026-10-26, Asia/Seoul.
