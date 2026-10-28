# 저장소 수집 어댑터

작업별 LLM 분석은 `OpenAiAnalysisProvider`로 제공한다. 명시적인 키·모델·context window와 검토한 발췌 ID가 필요하며 전송 제외/마스킹, 공급자 토큰 계산, 분석 1회, 응답·사용량·도메인 출력 검증을 수행한다. import·생성자만으로 요청하지 않는다. `prepareOpenAiAnalysisRequest`는 미리보기와 실제 호출이 공유하는 순수 요청 조립 함수다. CLI에 분석·로컬 저장·결과 캐시를 연결했으며 사용자 확인·성과 생성은 후속이다. [분석 호출 계약](../../docs/llm-analysis.md)과 [CLI 사용법](../../docs/analysis-cli.md)을 따른다.

공통 계약은 `@git-analyze/core`의 `RepositoryReader`다.

- Git CLI 수집: GitHub·SourceCommit·일반 원격·로컬 저장소의 공통 이력.
- GitHub API 보강: PR·이슈·리뷰·검증 결과.
- SourceCommit: Git 연결을 우선하고 공개 API는 확인된 범위에서만 사용.

현재 공급자 카탈로그와 `collectLocalHistory`를 제공한다. `local`은 `implemented`이며 나머지 원격 어댑터는 `planned`다. 문서상 지원과 현재 사용자에게 허용된 기능을 구분한다.

`src/git/local-history.ts`는 로컬 ref를 고정된 OID로 해석한 뒤 커밋 메타데이터와 변경 파일을 수집한다. 기본 ref는 CLI에서 `HEAD`로 지정한다. 날짜는 커미터 시각으로 필터링하며 과거 날짜의 자식 커밋에서 탐색을 중단하지 않는다.

파일 목록은 첫 부모와 비교하고 root commit은 빈 트리와 비교한다. rename 탐지를 끄므로 이름 변경은 삭제·추가로 나온다. Git 명령은 shell 없이 인자 배열로 실행한다. shallow 저장소·없는 ref·출력 제한 초과는 오류 처리한다.

`pathFilter`는 저장소 루트 기준의 리터럴 상대 경로다. Git diff에 `:(top,literal)` pathspec을 적용해 하위 파일만 가져오고, 해당 변경 파일이 없는 커밋은 제외한다. 커밋 탐색에는 경로 조건을 넣지 않아 경로별 이력 단순화와 부모 관계 변경을 피한다. 메시지는 원문이며 JSON의 `pathFilter`와 Markdown에 적용 범위를 기록한다. 경로를 생략하거나 `.`을 지정하면 전체 저장소다.

절대 경로·상위 경로 이동은 거부하며 경로 필터 전 기간 내 검사 대상은 1,000건으로 제한한다. 경로를 실제 작업 트리에서 찾지 않으므로 삭제된 경로의 이력도 수집할 수 있다. [Git pathspec 문서](https://git-scm.com/docs/gitglossary#def_pathspec).

현재 함수는 기간별 로컬 수집 경로다. 증분 동기화와 patch 조회를 포함한 `RepositoryReader` 전체 구현, 원격 인증·fetch·clone은 후속 작업이다. `github/`, `sourcecommit/` API 보강 모듈도 아직 없다.

동작 기준: [git-log](https://git-scm.com/docs/git-log), [git-diff-tree](https://git-scm.com/docs/git-diff-tree), [git-rev-parse](https://git-scm.com/docs/git-rev-parse).
