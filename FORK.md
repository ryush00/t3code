# 포크 운영 방침

이 저장소(`ryush00/t3code`)는 [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code)의 포크이며, **업스트림 `main`을 계속 추종**한다. 자체 기능을 키우는 저장소가 아니라, 업스트림에 아직 머지되지 않은 수정을 먼저 얹어 쓰는 저장소다.

동기화 절차는 [fork-sync 스킬](.agents/skills/fork-sync/SKILL.md)에 있다.

## 브랜치

| 브랜치 | 역할                                                                                     |
| ------ | ---------------------------------------------------------------------------------------- |
| `main` | 업스트림 `main`의 순정 미러. fast-forward로만 움직인다. **직접 커밋하지 않는다.**        |
| `fork` | 기본 브랜치. 항상 `main` 위에 포크 패치만 리베이스해 얹는다. 리베이스마다 강제 푸시된다. |

현재 얹혀 있는 패치는 `git log main..fork`가 정답이다. 목록을 문서에 따로 적지 않는다.

## 패치 규칙

- 패치는 업스트림에도 PR로 올린다. 업스트림이 머지하면 다음 리베이스에서 커밋이 비어 자동으로 사라진다.
- 업스트림에 보낼 PR 브랜치는 `fork`가 아니라 `main`에서 딴다.
- 포크에만 필요한 것은 업스트림에 없는 새 파일로 만든다(`fork-` 접두사 워크플로우, 이 문서, 스킬). 업스트림 파일을 고치면 리베이스 충돌이 생긴다.
- 업스트림 파일을 꼭 고쳐야 하면 한 커밋에 모으고 변경 줄 수를 최소로 한다.

## 릴리즈

포크는 **나이틀리 채널로만** 릴리즈한다. 업스트림 `main`을 따라가므로 내용물이 업스트림 나이틀리와 같기 때문이다.

- 버전은 기존 자동 업데이트 호환을 위해 `X.Y.Z-nightly.YYYYMMDD.N` 형식을 유지하되, 같은 날 업스트림 나이틀리와 충돌하거나 낮게 정렬되지 않도록 `N`을 `1000000 + GITHUB_RUN_NUMBER`로 띄운다. `X.Y.Z`는 데스크톱 패키지 버전의 다음 패치다.
- [fork-release.yml](.github/workflows/fork-release.yml)이 `fork` 브랜치를 빌드해 GitHub 프리릴리즈로 올린다. 태그를 손으로 만들지 않는다.
- 앱 이름은 "T3 Code (Nightly)"지만 앱 ID와 데이터 폴더는 정식 빌드와 같다. 공식 빌드와 동시에 띄우지 않는다.
- 자동 업데이트 피드는 빌드한 저장소(`GITHUB_REPOSITORY`)를 가리키므로 포크 릴리즈만 따라간다. 모든 플랫폼이 Nightly 채널에서 자동 업데이트된다.
- macOS 빌드는 Apple 시크릿(`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`)이 모두 있으면 포크 소유자의 Developer ID로 서명하고 공증한다. 번들 ID `com.t3tools.t3code`는 업스트림 팀 소유라 프로비저닝 프로파일을 받을 수 없으므로 `MACOS_PROVISIONING_PROFILE` 없이 서명하고, 앱 내 브라우저의 패스키는 빠진다. 이때의 권한은 [fork-entitlements.mac.plist](scripts/fork-entitlements.mac.plist)에 있다.
- 시크릿이 빠지면 임시(ad hoc) 서명으로 떨어진다. 임시 서명의 기본 지정 요구사항은 빌드마다 다른 cdhash라서 Squirrel.Mac이 다음 빌드를 거부하므로, [sign-macos-adhoc.ts](scripts/sign-macos-adhoc.ts)가 요구사항을 번들 ID로 고정한다. 이 빌드는 처음 열 때 `xattr -cr "/Applications/T3 Code (Nightly).app"`이 필요하다.
- 서명 주체가 바뀌면(임시 서명에서 Developer ID로, 또는 인증서 교체) 그 경계의 업데이트는 거부된다. 새 `.dmg`를 한 번 직접 설치한다.
- `t3` CLI와 원격 서버의 자체 업데이트 및 트랙 전환 조회(`server.npmRelease`)도 빌드한 저장소(`GITHUB_REPOSITORY`)의 릴리즈를 본다. 포크 서버에 포크 저장소에 없는 버전(예: 업스트림 클라이언트에서 보낸 업스트림 버전)이 요청되면(404) 업스트림으로 덮어쓰지 않고 저장소 불일치를 안내한다.

## 자동 동기화

[fork-sync-upstream.yml](.github/workflows/fork-sync-upstream.yml)이 매일 19:17 UTC(한국 04:17)에 돈다.

1. `main`을 업스트림 `main`으로 fast-forward한다.
2. `fork`를 새 `main` 위로 리베이스하고 타입체크한다.
3. `fork`가 움직였으면 강제 푸시하고 나이틀리 릴리즈를 시작한다.
4. 충돌이나 실패가 나면 아무것도 덮어쓰지 않고 "Upstream sync failed" 이슈를 남긴다. 이때는 스킬 절차대로 손으로 리베이스한다.

이 워크플로우는 쓰기 권한 deploy key("Fork Sync Upstream workflow")로 푸시하며, 그 개인 키가 `FORK_SYNC_DEPLOY_KEY` 시크릿에 들어 있다. 업스트림이 워크플로우 파일을 자주 바꾸는데, 기본 `GITHUB_TOKEN`은 그런 커밋을 푸시할 수 없다. 키를 바꿀 때는 새 키 쌍을 만들어 deploy key와 시크릿을 함께 교체한다.

## 저장소 설정

- 기본 브랜치는 `fork`다. 예약 워크플로우는 기본 브랜치의 파일로만 돈다.
- 업스트림 워크플로우는 포크에서 모두 꺼 둔다. 전용 러너와 시크릿을 요구해 포크에서는 대기 상태로 남는다. 켜 두는 것은 `Fork Desktop Release`, `Fork Sync Upstream`, 그리고 릴리즈가 호출하는 `Release desktop build`뿐이다. 업스트림이 워크플로우를 새로 추가하면 그것도 끈다.
- Issues를 켜 둔다. 동기화 실패 알림이 이슈로 온다.

## 로컬 리모트 이름

이 체크아웃에서는 `origin`이 업스트림(`pingdotgg/t3code`)이고 `fork`가 이 저장소다. 푸시 전에 `git remote -v`로 확인한다.
