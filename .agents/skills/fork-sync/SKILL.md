---
name: fork-sync
description: Sync this fork (ryush00/t3code) with upstream pingdotgg/t3code - mirror main, rebase the fork branch, resolve conflicts, and publish a fork nightly. Use for "업스트림 동기화", "업스트림 추종", "포크 리베이스", "포크 릴리즈", an "Upstream sync failed" issue, or when adding or dropping a fork patch.
---

# 포크 동기화

방침과 이유는 [FORK.md](../../../FORK.md)에 있다. 여기는 손으로 할 때의 절차다. 평소에는 `Fork Sync Upstream` 워크플로우가 매일 같은 일을 한다.

리모트 이름은 체크아웃마다 다르다. 먼저 `git remote -v`로 어느 것이 `pingdotgg/t3code`(아래 `UP`)이고 어느 것이 `ryush00/t3code`(아래 `FK`)인지 확인한다.

## 1. 동기화

```sh
git fetch --no-tags UP main
git fetch FK main fork

# main은 fast-forward만 한다. 거부되면 main에 누가 커밋한 것이니 멈추고 보고한다.
git push FK UP/main:refs/heads/main

git switch -C fork-sync FK/fork
git rebase UP/main
```

`fork`를 이미 다른 worktree가 잡고 있을 수 있으므로 임시 브랜치 `fork-sync`에서 작업한다.

## 2. 충돌 해결

- 업스트림이 같은 수정을 머지했으면 그 패치는 버린다: `git rebase --skip`. 업스트림 구현이 우리 것과 다르면 업스트림 쪽을 택한다.
- 그 밖에는 업스트림 변경을 살리고 패치를 그 위에 다시 맞춘다. 패치의 의도는 커밋 메시지와 연결된 업스트림 PR에서 확인한다.
- 충돌 표시를 지운 뒤에도 자동 병합된 구간이 옛 이름을 참조할 수 있다. 반드시 테스트로 확인한다.

## 3. 검증

```sh
vp run check:changed
vp test run <패치가 건드린 테스트 파일>
```

`vp`가 PATH에 없으면 `node_modules/.bin`을 PATH에 추가한다.

## 4. 푸시와 릴리즈

```sh
git push --force-with-lease=fork:FK/fork FK fork-sync:refs/heads/fork
gh workflow run fork-release.yml -R ryush00/t3code --ref fork
gh run list -R ryush00/t3code --workflow fork-release.yml -L 1
```

`fork` 강제 푸시는 이 절차의 정상 동작이다. `main` 강제 푸시는 아니다.

릴리즈가 끝나면 프리릴리즈로 올라왔는지, `nightly.yml`과 `nightly-mac.yml`이 자산에 있는지 확인한다. 둘이 없으면 자동 업데이트가 새 빌드를 찾지 못한다.

## 패치 추가와 제거

- 추가: 업스트림 `main`에서 브랜치를 따 업스트림에 PR을 올리고, 같은 커밋을 `fork`에 체리픽한다.
- 제거: `git rebase -i`를 쓸 수 없는 환경이면 `git rebase --onto <커밋>^ <커밋> fork-sync`로 그 커밋만 뺀다.
- 포크 전용 변경은 업스트림에 없는 새 파일에 둔다.

## 업스트림이 워크플로우를 추가했을 때

포크에서는 돌 수 없으므로 끈다.

```sh
gh workflow list -R ryush00/t3code --all
gh workflow disable <이름 또는 ID> -R ryush00/t3code
```

`Fork Desktop Release`, `Fork Sync Upstream`, `Release desktop build`만 켜 둔다.
