# 사용자 검토와 성과 문장 CLI

기준일: 2026-10-29, Asia/Seoul.

`analyze → review → resume`로 작업 한 건의 분석을 검토하고 성과 문장 초안을 출력한다. `review`·`resume`은 API 키·DB·Git 연결 없이 로컬 파일만 사용하며 외부 요청은 0회다. 문장을 새로 추론하는 LLM 호출은 없다.

## 1. 분석 열기

```powershell
pnpm cli review --analysis ".data\law-analysis\analysis.json" --output ".data\law-review-initial"
```

`review.json`과 `review.md`에 주장 ID·상태·근거·보충 질문을 표시한다. 저장된 성공 분석의 구조·사용량·요청 버전·전송 입력을 검증하고, 분석 보고서가 가리키는 원래 `evidence.json`의 내용 hash·연결·기간을 다시 대조한다. 원본 근거 파일과 분석 파일을 보존해야 하며, 삭제·변경되면 검토/출력을 중단한다.

이미 제외·마스킹된 전송 본문을 검증하므로 마스킹 비밀 값 파일은 다시 필요하지 않다. 저장된 발췌의 원본 인용·선택·제외·완전성과 마스킹 결과를 확인하고 모델 입력 버전을 재계산한다. 원본 보고서의 전체 내용을 외부로 보내지 않는다.

검토 저장소는 기본 `.data/reviews/<소유자·저장소·작업 hash>`다. `--store-dir`로 별도 루트를 지정할 수 있다. 같은 작업은 같은 저장 루트를 계속 사용한다. 로컬 ID·actor 표시는 인증을 대신하지 않으며 파일과 저장 루트는 사용자가 관리한다.

## 2. 보충·편집·확인

`changes.json`에 사용자 행동을 순서대로 기록한다. 다음은 형식 설명용 예시이며 문구·주장 ID·질문·날짜를 실제 분석과 사실에 맞게 바꾼다.

```json
{
  "schemaVersion": 1,
  "actions": [
    {
      "kind": "answer",
      "section": "results",
      "claimId": "user-result-1",
      "question": "실제 테스트 실행 결과는 무엇인가요?",
      "text": "동시 요청 10건에서 주문 생성 1건을 확인함"
    },
    {
      "kind": "confirm",
      "claimId": "user-result-1",
      "text": "동시 요청 10건에서 주문 생성 1건을 확인함"
    },
    {
      "kind": "confirm",
      "claimId": "contribution-1",
      "text": "멱등성 처리 구현을 담당함"
    },
    {
      "kind": "completion",
      "status": "completed",
      "completedAt": "2026-10-26T03:00:00+09:00",
      "note": "검증 결과와 반영 완료를 직접 확인함"
    }
  ]
}
```

```powershell
pnpm cli review --analysis ".data\law-analysis\analysis.json" --changes ".data\changes.json" --actor "사용자 식별명" --output ".data\law-review-approved"
```

- `answer`: 새 사용자 주장 추가. `section`은 `problem`, `constraints`, `alternatives`, `decision`, `implementation`, `results`, `verification`, `contribution` 중 하나다. `question`은 보충 질문의 정확한 문구 또는 일반 보충이면 null이다. 새로운 `claimId`가 필요하다.
- `edit`: `{ "kind": "edit", "claimId": "...", "text": "새 문구" }`. 기존 원본은 분석 파일과 이전 버전에 남고, 편집 문구는 `inferred` 상태가 된다. 기존 확인은 철회 상태로 바뀐다.
- `confirm`: 현재 주장 문구와 정확히 일치해야 한다. 해당 행동 ID가 `confirmationId`이며 소유자·저장소·작업·전송 입력 버전·주장 ID·문구를 함께 저장한다. 모델이 출력한 확인 ID는 수락하지 않는다.
- `revoke`: `{ "kind": "revoke", "confirmationId": "확인 기록 ID" }`. 해당 주장은 미확인 상태로 돌아간다. 답변의 확인을 철회하면 연결된 질문도 다시 보충 필요가 된다.
- `completion`: `completed`에는 시간대가 있는 완료 시각과 확인 설명이 필요하다. 완료 판단을 보류하거나 철회하려면 `status`를 `in_progress` 또는 `unknown`, `completedAt`을 null로 지정한다. 커밋 날짜·테스트 파일만으로 완료를 자동 확정하지 않는다.

답변 작성과 편집은 확인이 아니다. 별도의 `confirm`이 있어야 `user_confirmed`가 된다. 원본 기록이 직접 뒷받침하는 `source_supported`와 사용자 확인을 구별한다. 질문은 확인된 답변이 있을 때만 해결 상태가 된다. 한 입력 파일은 최대 1 MiB·100개 행동, 누적 이력은 최대 1000개 행동이다. 잘못된 행동이 하나라도 있으면 전체 배치를 거부하고 저장된 HEAD를 바꾸지 않는다.

## 3. 한 문장 출력

`review.md`에서 사용할 주장 ID를 선택해 문장 순서대로 지정한다.

```powershell
pnpm cli resume --review ".data\law-review-approved\review.json" --claim "problem-1" --claim "implementation-1" --claim "user-result-1" --claim "contribution-1" --output ".data\law-resume"
```

기본 `--kind achievement`는 선택된 구현·결과와 사용자가 확인한 본인 기여, 명시적인 완료 확인이 있어야 출력한다. 결과·완료 확인 없이 구현 활동만 출력하려면 `--kind activity`를 지정한다. 이 경우에도 구현과 사용자 확인된 본인 기여가 필요하다. 추정·누락·철회된 주장, 존재하지 않는 ID, 중복 선택은 거부한다.

최대 8개 주장의 정확한 문구에서 공백·끝 문장부호만 정리하고 `; `로 연결해 한 문장으로 출력한다. 새 수치·인과관계·효과·개인 기여 표현을 추가하지 않는다. 하나의 주장에 여러 문장이 들어 있으면 먼저 편집·확인해야 한다. 문체를 다듬으려면 각 주장을 짧은 문구로 편집한 뒤 확인한다. 이는 의미적 사실성을 자동 판정하는 기능이 아니다.

`resume.json`·`resume.md`에는 문장과 함께 주장별 원문·상태, 문장 내 `[start, end)` UTF-16 문자 위치, Git 커밋·부모·경로·locator·발췌, 사용자 확인 기록·actor·시각, 전체 문제/제약/대안/선택/구현/결과/검증/기여와 남은 질문을 보존한다. 활동 수집 기간과 사용자가 확인한 완료일은 별도로 표시하며, 이 명령은 완료일 기준 기간 필터나 다중 작업 순위 산정을 하지 않는다.

## 4. 버전·철회·재분석

검토 변경은 새 불변 JSON 버전으로 저장하고 마지막에 `HEAD.json`을 교체한다. 이전 상태와 사용자 행동은 삭제하지 않는다. 같은 작업의 변경과 문장 출력은 같은 lock을 사용한다. 실패한 저장·손상 상태를 자동 승인하거나 복구하지 않는다. 비정상 종료로 lock이 남으면 실행 중인 프로세스가 없음을 확인한 뒤 해당 `.lock` 디렉터리만 수동 제거한다.

`resume`은 검토 보고서의 버전과 현재 저장소 HEAD가 일치하는지 다시 검사한다. 확인·편집·철회·완료 상태가 바뀌면 이전 `review.json`으로 새 문장을 출력할 수 없다. `review --analysis ...`를 변경 파일 없이 실행해 최신 보고서를 받는다. 이미 출력한 Markdown은 당시 버전의 이력으로 남으며 자동 수정·삭제하지 않는다.

재분석한 입력 또는 분석 주장 내용이 바뀌면 명시적으로 재검토한다.

```powershell
pnpm cli review --analysis ".data\law-analysis-new\analysis.json" --rebase --actor "사용자 식별명" --output ".data\law-review-rebased"
```

기존 사용자 편집과 추가 답변은 미확인 초안으로 보존한다. 새 근거에 없는 인용은 제거하고 기존 확인은 철회 상태로, 완료 상태는 미확인으로 되돌린다. 작업 범위·주장 섹션이 충돌하면 자동 병합하지 않는다. 같은 실제 전송 입력·분석 주장으로 경로·기간·모델 메타데이터만 바뀐 보고서는 기존 검토 상태를 재사용한다.

원시 LLM 분석 캐시는 사용자 확인과 독립적이다. 검토 명령은 모델 분석을 다시 호출하거나 생성 캐시를 수정하지 않는다. 문장 버전은 현재 검토 버전·선택 주장·출력 정책을 포함하므로 확인·철회가 바뀌면 달라진다. 문장은 매번 오프라인으로 조합한다. 사용자 보충을 모델 입력에 넣는 후속 기능을 추가한다면 별도 전송 검토와 분석 캐시 무효화가 필요하다.
