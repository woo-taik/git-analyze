# 저장소 수집 어댑터

공통 계약은 `@git-analyze/core`의 `RepositoryReader`다.

- Git CLI 수집: GitHub·SourceCommit·일반 원격·로컬 저장소의 공통 이력.
- GitHub API 보강: PR·이슈·리뷰·검증 결과.
- SourceCommit: Git 연결을 우선하고 공개 API는 확인된 범위에서만 사용.

현재 코드는 공급자 카탈로그만 제공한다. 모든 어댑터의 `implementationStatus`는 `planned`다. 수집·인증·원격 접속은 아직 구현하지 않았다. 문서상 지원과 현재 사용자에게 허용된 기능을 구분한다.

실제 수집기는 이 패키지 내부의 `git/`, `github/`, `sourcecommit/` 모듈로 추가한다. 다른 공급자 ID나 경로를 LLM 분석 로직으로 전달해 분기하지 않는다.
