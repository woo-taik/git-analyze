# 다중 저장소 공급자 지원

기준일: 2026-10-20. 상태: 공식 문서 확인을 바탕으로 한 설계. 실제 저장소 접속·수집은 아직 수행하지 않았다.

## 1. 지원 방향

Ncloud가 NAVER Cloud Platform의 **SourceCommit**을 의미한다면 커밋 이력 수집이 가능하다. 공식 가이드에서 HTTPS/SSH 자격 증명을 사용한 Git clone을 지원한다. 다른 Ncloud 환경의 자체 Git 서비스라도 실제 Git 원격 접근이 가능한지 확인해 공통 수집기를 적용할 수 있다.

근거: [SourceCommit Git 클라이언트 사용](https://guide.ncloud-docs.com/docs/sourcecommit-use-client).

제품의 입력을 GitHub 전용에서 **Git 공통 이력 + 공급자별 부가 정보**로 확장한다. 레포마다 GitHub, SourceCommit, 일반 Git 원격 또는 사용자가 지정한 로컬 저장소를 연결한다.

## 2. 수집 계층

### 공통 Git 수집기

- Git CLI로 커밋 OID·부모 관계·작성자/커미터·시간·메시지·변경 파일·필요한 diff를 읽는다.
- SSH 또는 HTTPS 원격과 로컬 저장소를 지원한다. 로컬 미커밋 변경은 기본 수집 대상에서 제외한다.
- 서비스가 관리하는 bare 캐시에 원격 ref를 fetch하고, checkout 없이 분석한다.
- 로컬 저장소를 사용할 때는 fetch 전 수집 범위를 정하고 사용자의 브랜치·작업 파일을 변경하지 않는다.
- 변경 파일 메타데이터부터 읽고, 선별된 작업의 diff만 근거 패킷에 넣는다.

Git 명령의 동작은 [git-log](https://git-scm.com/docs/git-log), [git-fetch](https://git-scm.com/docs/git-fetch), [git-clone](https://git-scm.com/docs/git-clone) 공식 문서를 기준으로 구현한다.

### GitHub 부가 정보 어댑터

Octokit으로 PR·이슈·리뷰·검증 결과를 수집한다. API만으로 충분한 저장소는 Git 캐시 생성 없이 처리할 수 있다. Git과 API 양쪽에서 발견한 커밋은 같은 저장소의 OID로 연결하고 별개 성과로 집계하지 않는다.

### SourceCommit 어댑터

커밋은 공통 Git 수집기를 기본으로 사용한다. 공개 API 목록에서 확인한 저장소·브랜치·태그 조회 등은 연결과 메타데이터 확인에 선택적으로 사용한다.

확인한 API 문서에는 커밋 상세·diff·PR·리뷰 조회가 명시되어 있지 않다. 이 사실을 서비스 전체에 해당 기능이 없다는 뜻으로 확대하지 않는다. 콘솔 화면의 정보가 외부 API로도 제공된다고 가정하지 않으며, 필요한 경우 지원되는 공식 경로를 추가 확인한다. 화면 스크래핑은 기본 설계에 넣지 않는다.

근거: [SourceCommit API 개요와 제공 목록](https://api.ncloud-docs.com/docs/en/devtools-sourcecommit).

### 기능 지원 정보

`RepositoryProvider`는 `commits`, `diff`, `refs`, `pull_requests`, `issues`, `reviews`, `checks`, `webhooks`의 지원 상태를 알려준다. 상태는 `supported`, `unsupported`, `unknown`, `permission_denied`를 구분한다. 미지원·미확인·권한 부족을 “활동 없음”으로 해석하지 않는다.

수집 결과는 공통 `source_record`로 정규화한다. 공급자 인스턴스·연결·저장소·원본 종류·외부 ID를 식별 범위에 포함한다. 공급자별 분기는 수집과 원본 링크 생성에 두고 이후 분석·LLM·기간 집계는 공유한다.

## 3. 추적 가능한 내용과 한계

Git 이력으로 확인할 수 있는 것은 변경 내용·작성자 메타데이터·커밋 메시지·부모 관계와 현재 수집한 ref의 포함 관계다.

다음 내용은 별도 근거가 필요할 수 있다.

- 문제의 배경과 실제 비교한 대안: PR·이슈·설계 기록 또는 사용자 보충.
- 테스트 실행 성공과 운영 효과: CI 실행·측정·배포 기록.
- 실제 push 시각과 최초 병합 시각: 공급자 이벤트 또는 수집 당시 관측 기록.
- 개인 기여의 정확한 범위: 이메일/계정 확인·공동 작업 기록.

커밋 작성일·커미터 날짜를 실제 반영일이나 업무 완료일로 단정하지 않는다. 처음 6개월 이력을 가져왔을 때 과거 커밋의 기본 브랜치 최초 반영일을 복원하지 못할 수 있다. 이 경우 활동일 대체 기준과 완료일 미확인을 표시한다.

PR이 없는 작업은 커밋 메시지의 명시적 이슈 키·관계와 사용자 묶기를 우선한다. 경로·시간·유사 제목은 묶기 후보를 만드는 신호이며, 동일 문제라는 확정 근거로 사용하지 않는다.

## 4. 증분과 비용

- 저장소별 선택 ref·이전 tip OID·수집한 OID를 기록한다. 날짜 필터만으로 새 커밋 발견 여부를 판단하지 않는다.
- fetch 후 새로 도달 가능한 OID를 확인한다. 과거 날짜의 cherry-pick·이력 가져오기도 누락하지 않는다.
- force push·rebase·브랜치 삭제를 감지하고 현재 도달 가능 상태를 갱신한다. 기존 분석 근거를 조용히 삭제하거나 새 SHA와 무조건 중복 처리하지 않는다.
- shallow clone은 기간 이전 배경·부모·병합 근거를 누락할 수 있다. 필요한 이력까지 확장하거나 불완전성을 표시한다.
- `--filter=blob:none` 같은 partial clone 최적화는 원격 서버 지원 확인 후 사용한다. SourceCommit 지원을 가정하지 않고 제한된 fetch 또는 일반 bare 수집으로 fallback한다.
- 최초 수집은 이력 전송 비용이 있을 수 있다. 이후에는 캐시와 증분 fetch를 재사용하고, LLM에는 필요한 발췌만 보낸다.
- 공급자와 관계없이 같은 근거 버전의 분석은 재사용한다. 원격 저장소 이전이나 mirror 중복은 사용자 확인된 동일 저장소 관계를 사용하며 소유자 경계를 넘겨 캐시를 공유하지 않는다.

## 5. 접근과 실행

- SourceCommit Git용 HTTPS 계정/비밀번호·SSH 키와 Ncloud API용 키/서명을 구분한다.
- 비밀 값은 원격 URL·명령 인자·일반 로그·LLM 입력에 넣지 않고 credential helper 또는 SSH agent 등으로 전달한다.
- Node에서 Git을 호출할 때는 shell 문자열 조합 대신 인자 배열을 사용하고 허용된 URL scheme·ref·OID를 검사한다.
- 입력 저장소를 실행하거나 설치하지 않는다. 임의 protocol·external diff·textconv·submodule 자동 실행을 차단하는 격리된 실행 설정을 사용한다.
- 서비스에서 원격 URL을 받는 경우 허용된 호스트와 네트워크 접근 정책을 적용한다. 사내 저장소 접근은 명시적으로 설정한 연결을 사용한다.
- 접근 권한·통신 가능 경로가 없는 저장소는 수집할 수 없다. 이는 LLM이나 어댑터로 우회하지 않는다.

## 6. 변경된 MVP 순서

공통 Git 수집과 공급자 중립 모델을 먼저 만든다. GitHub는 PR/이슈를 보강하고 SourceCommit은 Git 커밋만으로 최소 경로를 검증한다. 이후 부족한 판단·결과 근거를 사용자 보충으로 연결한다. 기존 TypeScript·PostgreSQL·워커·LLM 재사용 설계는 유지한다.
