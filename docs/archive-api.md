# 로컬 검토 API

PostgreSQL에 `db-archive`로 가져온 검토를 읽고 수정한다. 저장소별 작업 목록, 최신 검토와 원본 근거, 선택한 주장의 성과 문장을 제공한다. 로컬 분석 파일이나 Claude 연결 없이 조회·수정할 수 있다.

## 실행

`.env`의 `DATABASE_URL`을 설정하고 다음을 실행한다.

```sh
pnpm db:migrate
pnpm dev:api
```

기본 주소는 `http://127.0.0.1:3000`이다. DB가 설정된 API는 loopback HOST만 허용하며 검토 조회는 로컬 연결과 loopback Host를 검사한다. 다른 사이트의 Origin 요청은 거부한다. owner ID는 로컬 데이터 선택 조건이며 사용자 인증이 아니다. 다중 사용자 공개 서비스에는 인증·인가가 추가로 필요하다.

`GET /health`는 DB와 관계없이 생존 상태를 반환한다. `GET /ready`는 DB의 조회 가능 상태를 검사해 성공 시 `status: "ready"`, `capabilities: { archiveRead: true, asyncAnalysis: true }`를 반환한다. DB 미설정·접속 실패·스키마 누락은 503이다. 준비 상태는 검토 조회와 분석 접수 테이블을 검사한다. 워커 실행 여부나 공급자 연결 성공을 의미하지 않는다.

## 조회

공통 경로는 `/v1/owners/:ownerId/repositories/:repositoryId/work-items`다. 각 ID는 `db-archive`에 사용한 외부 ID이며 URL 인코딩한다. JSON 응답과 오류는 `Cache-Control: no-store`로 제공한다.

- `GET <공통 경로>?limit=20&offset=0`: 검토가 저장된 작업의 목록. `items`에는 `workItemId`, `title`, `revision`, `reviewVersion`이 있다. 작업 ID 순으로 정렬하며 다음 페이지가 있으면 `nextOffset`을 반환한다. limit은 1~100이다. 없는 소유자·저장소 또는 빈 페이지는 빈 목록이다. 페이지 사이에 작업이 추가되면 offset 위치가 바뀔 수 있다.
- `GET <공통 경로>/:workItemId`: 최신 `reviewVersion`, `reviewRevision`, 검토 상태 `review`, 분석 입력 `evidence`, 수집 정보 `source`. 발췌와 사용자 확인/철회 이력을 포함한다. 내용 hash·검토 상태·근거 연결을 다시 검증한다.
- `GET <공통 경로>/:workItemId/resume?claim=구현ID&claim=결과ID&claim=기여ID`: 선택 순서대로 문장을 조합한다. claim은 1~8개이며 중복을 허용하지 않는다. `kind`는 `achievement`(기본) 또는 `activity`다. CLI와 같은 문장·문장 버전·절별 근거를 반환한다. 응답의 `externalRequests`는 0이다.

`resume`에 `reviewVersion=<상세 조회에서 받은 버전>`을 추가하면 검토가 바뀌었을 때 409를 반환한다. 생략하면 요청 시 DB의 최신 검토를 사용한다. 기본 성과 출력에는 구현·결과·확인된 본인 기여와 완료 확인이 필요하다. 활동 출력에도 구현·확인된 본인 기여가 필요하다. 원문 규칙은 [검토와 문장 CLI](review-resume-cli.md)를 따른다.

오류 상태는 잘못된 입력 400, 로컬 접근 조건 위반 403, 작업 없음 404, 검토 버전 변경 409, 미확인/철회된 주장 또는 문장 정책 위반 422, DB 사용 불가·저장된 내용 검증 실패 503이다. SQL·접속 정보·검증 실패 내용은 오류 응답에 포함하지 않는다. DB 연결과 SQL 실행은 각각 5초로 제한한다.

로컬에서 수정하거나 철회한 검토는 `pnpm cli db-archive --review <최신 review.json>`으로 다시 가져온 뒤 조회에 반영된다. API는 로컬 검토 파일의 변경을 감시하지 않는다. 조회 도중 같은 작업을 갱신하는 가져오기는 DB 트랜잭션으로 직렬화한다.

## 검토 수정

`POST <공통 경로>/:workItemId/review`로 DB에 가져온 검토를 수정한다. 본문은 다음 형식이다.

```json
{
  "expectedReviewVersion": "상세 조회에서 받은 64자리 버전 hash",
  "actor": "local-user",
  "changes": {
    "schemaVersion": 1,
    "actions": [
      { "kind": "edit", "claimId": "implementation-1", "text": "검토 후 수정한 구현 설명" }
    ]
  }
}
```

`changes`는 CLI와 같은 `answer`, `edit`, `confirm`, `revoke`, `completion` 행동을 1~100개 받는다. 상세 필드는 [검토 CLI](review-resume-cli.md)를 따른다. `actor`는 로컬 사용자 표시이며 인증 수단이 아니다. 확인 시 정확한 현재 문구가 필요하며 편집은 기존 확인을 철회하고 미확인 초안으로 바꾼다. 기록 시각은 서버에서 생성한다.

성공은 201이며 새로운 `reviewVersion`, `reviewRevision`, 검토·근거와 `externalRequests: 0`을 반환한다. 요청 형식 오류는 400, 최신 버전 불일치는 409, 없는 주장·확인 문구 불일치 등 행동 적용 실패는 422다. 배치 중 한 행동이 실패하면 전체를 저장하지 않는다. 동일 버전의 동시 수정은 한 요청만 성공하며 나머지는 최신 상세를 다시 읽고 수정해야 한다. 응답을 받지 못했을 때도 먼저 최신 상태를 조회한다.

수정은 같은 작업의 가져오기·문장 출력과 DB 행 잠금을 공유하고 새 검토 버전만 추가한다. 철회는 이후 API 및 `resume-db` 출력에 바로 반영된다. 이전 버전을 지정한 문장 요청은 409다.

API 수정은 로컬 검토 파일에 역동기화되지 않는다. DB보다 오래되거나 분기된 로컬 이력을 `db-archive`로 가져오면 거부하며 API 변경을 덮어쓰지 않는다. API에서 수정한 작업은 DB 최신 검토를 기준으로 계속 편집한다. 새 비동기 분석의 검토 시작은 현재 결과 JSON 저장 → CLI `review` → `db-archive` 경로를 사용한다. 분석 작업에서 직접 검토를 시작하거나 재분석에 rebase하는 API는 후속이다.

## 검증

```powershell
$env:GIT_ANALYZE_TEST_DATABASE_URL = 'postgresql://사용자:암호@127.0.0.1:포트/테스트DB'
pnpm check
```

별도 테스트 DB에 migration을 먼저 적용한다. 테스트는 fixture 소유자/작업을 저장하므로 개발 데이터와 분리한다. DB 환경 변수 없이 실행하면 PostgreSQL 통합 테스트 4건을 건너뛴다. 통합 테스트는 중복 가져오기, 페이지 조회, 같은 ID의 다른 소유자·저장소 분리, 로컬 분석 파일 없이 CLI/API 문장·근거 일치, 오래된 버전 거부와 가져온 철회 반영을 확인한다. 유휴 연결 종료 후 재연결과 분석 테이블 누락 시 준비 상태 실패도 검증한다. 이 과정에서 전용 테스트 DB의 임시 스키마를 생성·삭제하고 테스트가 만든 연결만 종료하므로 테스트 계정은 해당 권한이 필요하다. 모델 호출은 모형 응답을 사용한다.

API 편집의 배치 전체 취소, 확인·철회의 즉시 반영, 동시 편집 충돌과 오래된 CLI 가져오기 거부는 전용 DB 통합 테스트에서 검사한다. 기본 실행에서는 입력 형식과 로컬 접근 제한을 검사한다.
