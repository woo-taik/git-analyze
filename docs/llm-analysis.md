# Claude 분석 어댑터

기준일: 2026-10-29, Asia/Seoul.

이 프로젝트의 실제 LLM 호출은 Anthropic Claude를 사용한다. 기본 CLI 공급자는 `claude`, 인증 변수는 `ANTHROPIC_API_KEY`다. `ClaudeAnalysisProvider`는 공식 `@anthropic-ai/sdk`로 Messages API를 호출한다. import·생성만으로 요청하지 않으며 다른 공급자로 자동 전환하지 않는다.

## 호출 계약

```ts
import { ClaudeAnalysisProvider } from '@git-analyze/providers';

const provider = new ClaudeAnalysisProvider({ apiKey, model, contextWindowTokens, timeoutMs: 60_000 });
const result = await provider.analyze(packet, {
  maxInputTokens: 12_000,
  maxOutputTokens: 6_000,
  transmission: { allowedExcerptIds: reviewedExcerptIds, redactValues: secretsToMask },
});
```

모델·context window를 명시하며 실제 모델 지원은 계정의 Models API나 공식 문서로 확인한다. 2026-10-29의 실제 표본에는 `claude-sonnet-5-5`를 사용했다. 예산·모델을 자동 변경하지 않는다.

`LlmAnalysisProvider`는 공급자 독립 계약이다. 이 어댑터는 검증된 `WorkItemAnalysis`와 사용량·요청 기록을 반환한다. 사용자 확인이나 최종 성과 문장 생성은 별도 오프라인 `review`·`resume` 단계다.

## 전송 경계

토큰 계산도 선택된 근거를 Anthropic에 전송한다. 따라서 발췌 선택·민감 경로 제외·마스킹을 먼저 적용한다. 빈 선택·중복 ID·입력에 없는 ID를 거부한다. `prepareClaudeAnalysisRequest`는 CLI 미리보기·실제 요청·저장 분석 복원이 공유하는 순수 조립 함수다.

전송 내용은 작업 ID·입력 버전·완전성, 선택 커밋의 기여/후보 분류, 선택 발췌의 ID·인용·본문·완전성이다. 저장소 절대 경로·원본 보고서 전체·작성자/커미터 메타데이터·수동 묶음 제목·캐시 상태를 전송하지 않는다. 메시지나 코드 본문에 들어 있는 개인정보는 발췌 검토 대상이다.

민감 경로 정책은 `.env`·`.env.*`, `.npmrc`·`.netrc`, SSH 키, `.ssh`·`.aws`·`.azure`·`secrets`·`credentials` 디렉터리와 PEM/KEY/P12/PFX·비밀 설정 파일 등의 patch를 제외한다. `redactValues`는 본문에서 긴 값부터 정확히 일치하는 문자열을 `[REDACTED]`로 바꾼다. 알려진 일부 private-key/API-key 패턴이나 마스킹 값이 다른 전송 필드에 남으면 거부한다. 이는 모든 비밀을 찾는 탐지기가 아니다.

선택 제외·민감 경로·빈 본문 생략과 마스킹 ID를 receipt에 보존한다. 생략·마스킹이 있거나 원본이 불완전하면 전송 입력도 불완전하다. 원본 패킷은 수정하지 않는다. 전송 버전은 원본 입력 버전·전송 정책 버전·실제 전송 데이터를 정규화한 SHA-256이다.

원문은 user 메시지의 JSON 데이터이며 고정 지시문은 system으로 분리한다. 원문 속 지시를 실행하지 않고 근거로만 다루도록 명시한다. 테스트 추가와 실행 성공, 커밋과 배포, 기여 분류와 개인 성과 승인을 구분한다. 도구·이전 대화·서버 도구를 사용하지 않는다. endpoint는 `https://api.anthropic.com`으로 고정하고 SDK 로그와 자동 재시도를 끈다.

## 토큰·구조화 응답·사용량

[Claude 토큰 계산](https://platform.claude.com/docs/en/build-with-claude/token-counting)의 `messages.countTokens`에 모델·system·동일한 메시지·전체 출력 스키마를 전달한다. 이후 같은 본문으로 `messages.create`를 최대 한 번 실행하며 `max_tokens`를 예약 출력 예산으로 지정한다. 입력 예산 또는 입력+예약 출력의 context 예산이 초과되면 생성하지 않는다. 계산 실패를 근사 토큰 계산으로 우회하지 않는다.

[Claude 구조화 출력](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)의 `output_config.format`을 사용한다. 공급자 공통 생성 스키마는 `analysis-prompt.ts`에서 조립하고 `user_confirmed` 분기를 제외한다. 일부 크기·중복 제약은 로컬 도메인 검증에서 적용한다. 문법 제약만으로 사실성을 보증하지 않는다.

`stop_reason: end_turn`인 assistant message만 성공 후보로 처리한다. `max_tokens`·refusal·도구 호출·예상 밖 출력·누락/모순된 사용량·잘린 JSON·없는 인용은 성공 결과가 아니다. thinking 블록은 출력 문구로 사용하지 않으며, 텍스트 JSON을 기존 도메인 검증기로 검사한다. 계산과 생성을 합친 제한 시간은 기본·최대 60초다. CLI 기본 입력/출력 예산은 12,000/6,000토큰이다.

Claude usage의 `input_tokens`는 캐시 생성/읽기와 별도이므로 `inputTokens`는 세 값을 합친 전체 입력이다. `cachedInputTokens`는 캐시 읽기, `cacheCreationInputTokens`는 캐시 생성이다. `outputTokens`는 공급자 전체 출력이며 `reasoningTokens`가 있으면 그 안의 thinking 부분을 기록한다. 추론 토큰을 출력에 다시 더하지 않는다. 실제 모델·request ID도 보존한다.

실패는 `ClaudeAnalysisError`의 code·stage와 HTTP 상태·가능한 usage로 구분한다. 예산 실패는 계산된 입력도 보존한다. 외부 오류 원문·키·소스는 오류 메시지에 포함하지 않는다. usage가 null인 전송 오류는 무과금을 뜻하지 않는다. 실패는 정상 결과 캐시에 저장하지 않는다.

## CLI·캐시·보고서 호환

[분석 CLI](analysis-cli.md)에서 키 없는 미리보기·성공/실패 저장·입력/모델/설정별 캐시를 제공한다. 공급자를 캐시 키와 결과 검증에 포함해 이전 공급자의 결과를 Claude 결과로 취급하지 않는다. 저장 분석 복원은 기록된 공급자로 요청을 재구성하며 네트워크를 호출하지 않는다.

이전 OpenAI 패키지 API·모형 테스트·보고서 읽기는 호환을 유지한다. 새 CLI 분석은 기본 Claude이며 공급자 전환은 명시적인 `--provider` 지정이 있어야 한다. 이 프로젝트의 실제 검증에서는 Claude만 사용했다.

## 실제 검증 범위

2026-10-29에 `C:\dev\law`의 최근 1주일에서 작성자 후보를 선별하고, 3개 표본(각각 4·2·5파일)의 근거를 실제 Claude로 분석했다. 3건 모두 구조화 응답·입력 버전·인용 검증과 오프라인 검토 저장에 성공했고, 재요청은 키 없이 외부 호출 0회로 재사용했다.

공급자 usage 합계는 입력 22,440토큰·출력 10,461토큰이며 출력 중 thinking 1,290토큰이다. 이는 표본 한 번의 실행 기록이며 비용 절감률·일반 품질 보장이 아니다. 과금 금액 자체는 확인하지 않았다. 개인 기여·완료 확인은 자동 생성하지 않았다.

품질 검토에서는 테스트 통과·배포·운영 성능을 근거 없이 확정하지 않는 점을 확인했다. 다만 `staleTime: 0`을 캐시 미사용으로 단순화한 문구와 한 주장에 여러 문장이 들어가는 사용성 문제가 있었다. 원시 응답을 보존하고 사용자 검토가 필요한 항목으로 다루며, 형식/인용 검증이 의미적 정확성을 보장한다고 보고하지 않는다.
