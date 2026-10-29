# LLM 분석 어댑터

기준일: 2026-10-29, Asia/Seoul.

`@git-analyze/providers`의 `OpenAiAnalysisProvider`는 OpenAI Responses API의 작업별 분석 어댑터다. 인스턴스 생성·import만으로 외부 요청을 보내지 않는다. 호출마다 전송 정책 적용 → 전체 입력 토큰 계산 → 예산 확인 → 분석 1회 → 종료 상태·사용량 확인 → 도메인 출력 검증을 수행한다. [analyze CLI](analysis-cli.md)에 오프라인 미리보기·로컬 분석/실패 저장·결과 캐시를 연결했다. DB 연결은 후속이다.

## 호출 계약

```ts
import { OpenAiAnalysisProvider } from '@git-analyze/providers';

// 호출 계층에서 키와 사용할 모델/리비전의 실제 context window를 명시한다.
const provider = new OpenAiAnalysisProvider({
  apiKey,
  model,
  contextWindowTokens,
  timeoutMs: 30_000,
});

// packet은 toEvidencePacket으로 만든 검증된 분석 입력이다.
// reviewedExcerptIds는 호출자가 전송 내용을 검토한 뒤 명시한 발췌 ID 목록이다.
const result = await provider.analyze(packet, {
  maxInputTokens: 8_000,
  maxOutputTokens: 1_000,
  transmission: {
    allowedExcerptIds: reviewedExcerptIds,
    redactValues: secretsToMask,
  },
});
```

키·모델에 기본값을 두지 않으며 환경 변수를 자동으로 해석하지 않는다. 모델 선택과 실제 사용 권한·context window 확인은 호출 계층의 책임이다. 모델을 자동 변경하거나 격상하지 않는다. 첫 구현은 텍스트·Structured Outputs·입력 토큰 계산을 지원하는 모델을 전제로 한다. 실제 모델별 지원과 품질은 운영 환경에서 별도 확인해야 한다.

`LlmAnalysisProvider`는 분석 계약이며 전체 `LlmProvider`는 여기에 성과 문장 생성 계약을 더한다. 이 어댑터는 분석 계약만 구현한다. 공통 포트의 원시 응답 타입은 `unknown`이지만 구체적인 `OpenAiAnalysisProvider.analyze`는 검증을 통과한 `WorkItemAnalysis`를 반환한다.

## 외부 전송 경계

토큰 계산 요청도 선택한 근거를 OpenAI에 전송한다. 따라서 전송 정책은 계산 요청보다 먼저 적용한다. 빈 목록·중복 ID·입력에 없는 ID는 거부한다. `allowedExcerptIds`는 검토된 발췌만 전송하도록 호출자가 선택하는 목록이며, 자동 사용자 승인이나 접근 권한 검사는 아니다.

기본 민감 경로 정책은 대소문자와 경로 구분자를 정규화해 `.env`·`.env.*`, `.npmrc`, `.netrc`, SSH 키 이름, `.ssh`·`.aws`·`.azure`·`secrets`·`credentials` 디렉터리, PEM/KEY/P12/PFX, secrets/credentials JSON·YAML·TOML 파일의 patch를 제외한다. `.env.example`도 이 보수적인 규칙에 포함된다. 커밋 메시지에 민감 파일 내용을 옮겨 적은 경우까지 경로 규칙이 식별하지는 않는다.

`redactValues`는 발췌 본문에서 긴 값부터 정확히 일치하는 문자열을 `[REDACTED]`로 대체한다. 식별자와 인용을 임의로 변경하지 않는다. 지정한 비밀 값이 ID·locator 등 다른 전송 필드에 남아 있으면 전송을 거부한다. 알려진 일부 private-key/API-key 패턴이 전송 데이터에 남은 경우도 거부한다. 이 검사는 모든 비밀·개인정보를 찾는 탐지기가 아니므로 발췌 선택과 실제 전송 내용의 검토가 필요하다. 빈 마스킹 값은 거부한다.

전송 본문은 작업 ID·전송 입력 버전·완전성, 기여/후보 분류와 선택된 발췌의 ID·인용·본문·완전성만 담는다. 원본 보고서 전체, 작성자/커미터 이름·이메일·시각, 저장소 절대 경로, 수동 묶음 제목, 캐시 상태, 제외한 발췌 본문은 보내지 않는다. 코드 자체나 선택된 메시지에 포함된 개인정보는 발췌 검토·마스킹 대상이다.

선택 제외·민감 경로·빈 본문의 생략 ID와 이유, 마스킹한 ID는 `request.transmission`에 기록한다. 원본 패킷은 변경하지 않는다. 생략·마스킹이 있으면 전송 입력은 불완전하며 마스킹한 발췌도 `complete: false`다. 원본 추출 단계에서 이미 불완전했던 상태도 유지한다.

`sourceInputVersion`은 원래 `EvidencePacket.version`이다. `inputVersion`은 원본 버전·전송 정책 버전·실제 전송 데이터를 정규화해 계산한 SHA-256이다. 모델의 출력과 검증은 이 전송 버전을 사용한다. 다른 발췌 선택이나 마스킹 결과는 다른 버전이 되며 제외한 근거를 인용하면 출력 검증에서 거부한다. CLI 캐시는 전송 버전 외에 소유자·저장소·작업, 모델·epoch·프롬프트·스키마·설정을 포함한다. 원시 분석에는 사용자 확인을 보내지 않아 확인 입력 버전은 `none-v1`이다. 사용자 검토는 별도 로컬 버전으로 보존하고 후속 문장 버전에 반영한다. 보충을 모델 입력에 보내는 기능을 추가할 때는 분석 캐시 무효화도 확장해야 한다.

원문은 user 역할의 JSON 데이터로 전달하고 고정 지시문은 별도로 둔다. 원문 속 지시를 실행하지 않고 근거로만 다루도록 명시한다. 테스트 파일과 실행 성공, 커밋과 배포, 기여 분류와 개인 성과 승인을 구분하도록 지시한다. 도구·대화 이력·이전 응답 연결을 사용하지 않는다. 고정 endpoint는 `https://api.openai.com/v1`이며 ambient `OPENAI_BASE_URL`·SDK 로그 설정으로 전송 대상이나 로그 수준이 바뀌지 않는다. 분석 요청은 `store: false`, `truncation: disabled`다. 이 설정이 공급자의 모든 로그·보존 정책을 없앤다는 의미는 아니다.

## 토큰과 응답

[OpenAI 입력 토큰 계산](https://developers.openai.com/api/docs/guides/token-counting)의 `responses.inputTokens.count`에 모델·고정 지시문·동일한 발췌·전체 출력 스키마를 보낸다. 글자 수나 patch 바이트 수를 토큰 수로 대체하지 않는다. 입력이 `maxInputTokens`를 초과하거나 입력과 예약 출력의 합이 `contextWindowTokens`를 초과하면 분석 호출 없이 오류를 반환한다. 토큰 계산 기능이 실패한 경우 근사 계산으로 우회하지 않는다.

실제 생성에는 같은 입력과 스키마, `max_output_tokens`를 전달한다. 출력 상한에는 모델의 추론 토큰도 포함될 수 있으므로 상한이 작으면 가시 출력 전에 미완료될 수 있다. 예산 부족을 자동 수정·재시도·근거 삭제로 감추지 않는다. 자동 재시도는 SDK에서 0회로 고정하고, 토큰 계산과 분석을 합친 제한 시간은 기본 30초·최대 60초다. 호출자가 `signal`로 취소할 수 있다.

[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)의 지원 범위에 맞춰 공통 도메인 스키마를 wire schema로 변환한다. `oneOf`를 상태 값이 구분되는 `anyOf`로, 상수 상태를 단일 enum으로 바꾸고 일부 길이·개수·중복 제약은 로컬 검증에서 적용한다. 처음 분석에는 사용자 확인 기록을 보내지 않으므로 `user_confirmed` 분기는 생성 스키마에서 제외한다. 서버 스키마 준수만으로 성공 처리하지 않고 기존 `parseWorkItemAnalysis`로 작업/전송 버전·주장 ID·인용·확인 기록까지 검증한다.

전체 응답과 assistant message가 완료 상태이고 거부가 없을 때만 JSON 본문을 처리한다. 명시적 실패, 미완료, 거부, 도구 호출·예상 밖 출력, 여러 출력 메시지, 누락되거나 모순된 사용량, 잘린 JSON과 검증 실패는 성공 결과가 아니다. 입력/출력 사용량과 캐시 토큰·추론 토큰의 범위 및 실제 예산도 확인한다. 인용의 존재 검사는 내용상 사실성을 보장하지 않는다.

성공 결과에는 `value`, `usage`, `request`가 있다. usage는 공급자가 보고한 실제 모델, 입력·캐시 입력·출력·추론 토큰과 요청 ID다. request는 요청 모델, 프롬프트·도메인 스키마·wire schema 버전, 계산된 입력 토큰, 예산, 전송 기록이다. 계산된 입력과 실제 사용량을 별도로 기록하며 요청 모델 alias와 실제 응답 모델도 구분한다.

실패는 `OpenAiAnalysisError`의 `code`·`stage`로 구분하고, HTTP 상태·출력 검증 오류 코드·사용량을 확인할 수 있다. 예산으로 중단한 계산 단계는 `countedInputTokens`도 보존한다. 서버가 사용량을 제공한 실패·미완료·거부·검증 실패는 `usage`에 남긴다. 전송 오류나 타임아웃에서 사용량을 알 수 없으면 null이며 무과금을 뜻하지 않는다. 외부 오류 원문·키·소스 본문은 오류 메시지에 포함하지 않는다. 전송 정책 위반은 외부 호출 전에 `TransmissionError`로 반환한다.

## 검증 범위

실제 SDK에 주입한 모형 fetch로 요청 형식·고정 endpoint·전체 토큰 계산 입력·외부 전송 제외/마스킹·예산·재시도 횟수·미완료/실패/거부·타임아웃·사용량·도메인 검증 연결을 검사한다. CLI 테스트는 실제 Git 추출 보고서 입력, 키 없는 미리보기, 최초 생성·저장, 동일 요청의 외부 호출 0회 재사용, 범위/설정별 캐시 분리·검증, 동시 miss 차단과 실패 사용량 보존을 확인한다. 이후 [사용자 검토와 문장 CLI](review-resume-cli.md)를 모형 결과에 연결했다. 검토·문장은 외부 호출 없이 실행한다. 키·모델의 실계정 접근, 실제 모델의 스키마 수락·토큰 계산·품질·지연·청구는 아직 검증하지 않았다.
