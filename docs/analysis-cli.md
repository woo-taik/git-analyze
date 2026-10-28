# 로컬 근거 분석 CLI

기준일: 2026-10-28, Asia/Seoul.

`collect → prepare → evidence → analyze`로 선택한 작업 한 건의 구조화 분석 초안을 저장한다. `analyze`는 이미 저장한 근거 파일만 읽으므로 Git·DB 없이 실행할 수 있다. 사용자 확인·철회 기록과 이력서 성과 한 문장 생성은 후속이다.

## 1. 원본 연결 파일 준비

`evidence.json`의 선택 커밋마다 원본 스냅샷을 하나씩 지정한다. 다음은 `bindings.json`의 형식이다. OID와 ID·버전은 실제 관리하는 값으로 바꾼다.

```json
{
  "schemaVersion": 1,
  "ownerId": "local-owner",
  "repositoryId": "law",
  "workItemId": "law-work-001",
  "sources": [
    {
      "ownerId": "local-owner",
      "repositoryId": "law",
      "commitOid": "<선택 커밋의 전체 OID>",
      "sourceRecordId": "law-commit-snapshot-001",
      "sourceVersion": "<해당 원본 스냅샷의 버전>"
    }
  ]
}
```

같은 소유자·저장소·작업에는 같은 ID를 유지한다. 원본 내용이 바뀌면 새 버전을 사용한다. 로컬 ID는 호출자가 관리하는 연결이며 DB 레코드를 생성하거나 존재·접근 권한을 검증하지 않는다. 범위 불일치, 선택 커밋의 누락·중복 매핑은 거부한다.

입력 근거는 schema v1, 지원되는 추출 규칙, 최대 20커밋·120발췌다. 근거 파일은 최대 32 MiB, 연결 파일과 마스킹 파일은 각각 최대 1 MiB의 UTF-8 JSON이다. 입력의 타입·배열 상한·시간·경로·바이트 집계·발췌 ID/locator와 내용 hash를 검사한다. hash는 변경 감지이며 진본 서명은 아니다. `analyze`는 Git 객체를 다시 읽지 않으므로 원본 파일과 연결 파일을 신뢰할 수 있는 위치에서 관리해야 한다.

## 2. 전송 미리보기

`evidence.md`에서 발췌 본문과 ID를 확인한다. 검토한 ID만 `--excerpt`로 반복 지정한다. 전체 자동 선택은 제공하지 않는다.

```powershell
pnpm cli analyze --input ".data\law-evidence\evidence.json" --bindings ".data\law-bindings.json" --excerpt "<검토한 발췌 ID>" --model "<사용할 모델 또는 리비전>" --model-epoch "2026-10-28-v1" --context-window <확인한 모델 context 토큰 수> --dry-run --output ".data\law-preview"
```

미리보기는 키 없이 외부 요청 0회로 `preview.json`과 `preview.md`를 저장한다. JSON에는 민감 경로 제외·마스킹 후의 `countRequest`와 `analysisRequest`가 있다. 실제 전송할 고정 지시문·근거·전체 출력 스키마를 포함한다. 토큰 계산은 실행하지 않으며 토큰 수를 추정하지 않는다. 실제 분석 시 같은 입력·옵션으로 다시 준비하므로 검토 후 원본이나 옵션이 바뀌면 미리보기를 다시 확인한다.

마스킹은 `--redactions-file <파일>`로 적용한다. 파일 내용은 `["마스킹할 값", "다른 값"]` 형태의 JSON 배열이다. 비밀 값을 명령행 인자로 받거나 저장 보고서·캐시에 복사하지 않는다. 원본 근거 파일은 변경하지 않는다. 경로 제외와 탐지는 [전송 정책](llm-analysis.md)을 따른다.

## 3. 분석과 저장

`OPENAI_API_KEY`를 환경 변수 또는 로컬 `.env`에 설정하고 같은 명령에서 `--dry-run`을 제거한다. 미리보기와 실제 분석의 출력 폴더는 각각 새 폴더를 사용한다.

- 필수: `--input`, `--bindings`, 반복 `--excerpt`, `--model`, `--model-epoch`, `--context-window`.
- 기본 예산: `--max-input-tokens 8000`, `--max-output-tokens 1000`.
- 제한 시간: `--timeout-ms 30000`, 최대 60000. 토큰 계산과 생성을 합친 제한이다.
- 모델·context window·실계정 지원 여부는 호출자가 확인한다. 모델 기본값·자동 변경은 없다.
- `--model-epoch`는 모델 리비전 또는 호출자가 관리하는 버전이다. 같은 모델 alias의 실제 대상이 바뀌면 epoch도 바꾼다.

캐시 miss에는 토큰 계산 1회와 분석 최대 1회를 실행한다. [OpenAI 공식 토큰 계산 문서](https://developers.openai.com/api/docs/guides/token-counting)에 따라 계산 요청도 근거를 외부로 전송하므로 미리보기와 발췌 검토가 필요하다. 기존 어댑터의 예산·응답·인용 검증을 통과해야 성공한다.

기본 출력은 `.data/analyses/<실행 ID>/analysis.json`·`analysis.md`다. 원본 파일 위치·내용 버전, 실제 저장소·ref·절대 기간·선택 커밋 수·경로 범위, 원본 연결, 전송한 본문·완전성·생략/마스킹 기록, 모델/프롬프트/스키마/설정, 분석·최초 사용량을 저장한다. 기존 폴더를 덮어쓰지 않으며 외부 요청 전에 출력 폴더를 확보한다.

외부 호출 실패·미완료·거부·예산/검증 실패는 `failure.json`·`failure.md`에 코드·단계·확인 가능한 사용량을 저장하고 종료 코드 1을 반환한다. 실패 원문·API 키는 저장하지 않는다. 사용량 null은 무과금을 의미하지 않는다. 자동 재시도는 없다.

## 4. 분석 캐시

기본 위치는 `.cache/analysis`, `--cache-dir`로 변경한다. 동일 요청은 키가 없어도 토큰 계산을 포함한 외부 요청 0회로 재사용하고 새 결과 보고서를 저장한다. 출력 위치·보고서 작성 시각·수집 기간만 달라지고 실제 근거 패킷·연결·설정이 같으면 재사용한다. 선택된 커밋이나 근거 내용이 바뀌면 별도 요청이다.

캐시 키는 소유자·저장소·작업, 전체 분석 입력/전송 버전·생략/마스킹 기록, 모델·epoch·프롬프트·도메인/wire schema, 입출력/context 예산·제한 시간·CLI 캐시 버전을 포함한다. 현재 사용자 확인 단계는 없으며 확인 상태 버전은 `none-v1`이다. 사용자 보충 기능을 연결할 때 별도 무효화가 필요하다. API 키와 마스킹 원문은 캐시에 저장하지 않는다.

캐시 hit도 digest·요청 설정·사용량 범위·현재 인용과 입력 버전·도메인 스키마를 다시 검사한다. 캐시의 usage는 최초 생성의 사용량이며 이번 실행의 추가 사용량이 아니다. 실패는 성공 캐시에 저장하지 않는다. 손상 캐시는 오류를 반환하며 자동 재호출하지 않는다. 명시적으로 캐시 읽기·쓰기를 건너뛰려면 `--no-cache`를 사용한다.

같은 키의 동시 miss는 `.lock` 디렉터리로 차단한다. lock은 정상 종료 시 제거하며, 실행 중인 프로세스가 없음을 확인한 뒤 비정상 종료로 남은 해당 lock만 수동 제거한다. 성공 결과 캐시는 임시 파일을 완성한 뒤 이름을 바꿔 저장한다. 캐시 쓰기 실패 시 결과 보고서를 보존하고 CLI 출력의 `cacheWarning: "cache_write_failed"`로 알린다. 이 경우 다음 실행은 새 요청일 수 있다.

로컬 파일의 소유자 ID와 hash는 다중 사용자 인증·인가를 대신하지 않는다. HTTP·DB·워커 연결, 사용자 보충/확인·철회, 최종 성과 문장, 실제 모델 접속·품질·지연·청구 검증은 후속이다.
