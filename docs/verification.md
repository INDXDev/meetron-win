# ローカル検証チェックリスト

## テスト構成

最初はGoogle Meetを推奨します。テスト会議には次の3参加者相当を用意します。

1. ユーザー本人: 通常のマイクとヘッドホンで参加
2. GPT参加者: ChatGPT Voiceと共用する専用Chromeプロファイルから`GPT-Live`として参加
3. 確認者: 別のPCまたはスマートフォンから参加し、GPT音声が実際に会議へ届くか確認

同じMacだけで確認すると、ヘッドホンのモニター音と会議へ送信された音を区別しにくいため、確認者は別端末にします。

## 0. 安全確認

- [ ] テスト会議であり、機密情報を扱わない
- [ ] 参加者へAI参加者が音声を処理することを通知した
- [ ] GPT参加者の会議マイクは初期状態でミュート
- [ ] ループ発生時に`./scripts/set-meet-mic.sh mute`を実行できる
- [ ] macOSの通知を集中モードで抑制した

## 1. 環境

```bash
./scripts/check-env.sh
```

- [ ] コマンドが終了コード`0`で終わる
- [ ] `BlackHole 2ch`が表示される
- [ ] `BlackHole 16ch`が表示される
- [ ] Node.jsとnpmが検出される
- [ ] Google Chromeが検出される
- [ ] `Meeting Copilot Output`をAudio MIDI Setupで作成済み

## 2. GPT参加者の起動

実際のURLへ置き換えます。

```bash
./scripts/open-gpt-participant.sh --dry-run "https://meet.google.com/xxx-yyyy-zzz"
./scripts/open-gpt-participant.sh "https://meet.google.com/xxx-yyyy-zzz"
```

- [ ] 同じ専用Chromeプロファイル内でChatGPT Voiceと会議ページが別タブで開く
- [ ] 表示名が`GPT-Live`
- [ ] カメラがオフ
- [ ] Microphoneが`BlackHole 16ch`
- [ ] Speakerが`BlackHole 2ch`
- [ ] Chromeのマイク権限が許可されている
- [ ] `Voice再起動`後もGPT参加者がMeetから退出しない
- [ ] GPT参加者の会議マイクがミュート

## 3. 会議からChatGPTへの片方向テスト

1. ChatGPT Voiceを開始する
2. 確認者が「入力テスト、青、42」と発話する
3. GPT参加者はまだミュートしたまま、ChatGPTへ「聞こえた3つの要素を答えて」と呼びかける

- [ ] ChatGPTが`入力テスト`、`青`、`42`を把握した
- [ ] 入力音声に大きな途切れや歪みがない
- [ ] ユーザー本人のマイク音声もChatGPTへ届く

失敗時はGPT参加者のSpeakerとChatGPT入力が、ともに`BlackHole 2ch`経路へ接続されているか確認します。

## 4. ChatGPTから会議への片方向テスト

1. `./scripts/set-meet-mic.sh unmute`を実行する
2. ChatGPTへ「テストと一言だけ発話して」と依頼する
3. `./scripts/set-meet-mic.sh mute`を実行する

- [ ] 確認者の別端末でChatGPTの音声が聞こえる
- [ ] GPT参加者の入力メーターがChatGPT発話中だけ動く
- [ ] ヘッドホンでもChatGPTの音声をモニターできる
- [ ] システム通知など余計な音声が会議へ送られない

失敗時はChatGPT出力が`Meeting Copilot Output`、Multi-Outputの構成要素がヘッドホンと`BlackHole 16ch`、GPT参加者のMicrophoneが`BlackHole 16ch`であることを確認します。

## 5. ループテスト

GPT参加者をアンミュートし、ChatGPTに1文だけ話させた後、10秒待ちます。

- [ ] ChatGPTが自分の声へ反応しない
- [ ] 同じ音声が繰り返されない
- [ ] 音量が連続して増幅しない

1項目でも失敗したら即座にGPT参加者をミュートし、[音声ルーティングのループ確認](audio-routing.md#6-ループの確認)へ戻ります。

## 6. 呼び出しと文脈テスト

[Project設定の初回シナリオ](chatgpt-project.md#5-初回テストシナリオ)を実施します。

- [ ] 名前を呼ばない通常会話では発話しない
- [ ] `GPT-Live、どう思う？`でのみ応答する
- [ ] `GPT、応答して`でも直前の議題へ応答する
- [ ] 直前の議題を正しく要約する
- [ ] リスクまたは前提を1つ以上示す
- [ ] 次の具体的行動を提案する
- [ ] 応答が30秒以内
- [ ] 応答後に再び沈黙する

`start-meeting-copilot.sh`は入室後にアンミュートします。名前を呼ばない通常会話で発話した場合は`./scripts/set-meet-mic.sh mute`で停止し、Project instructionsを調整します。この失敗は音声経路の失敗と分けて記録します。

## 7. 継続テスト

### 5分テスト（最低成功条件）

- [ ] 5分前の決定事項を質問し、正しく回答する
- [ ] 音声ループがない
- [ ] ユーザー本人の通常参加に支障がない
- [ ] GPT発話開始までの時間を計測した

### 15分テスト（次段階の条件）

- [ ] 議題変更を追跡できる
- [ ] 合意事項と未決事項を区別できる
- [ ] 15分間、意図しない発話がない、または外側ミュートで遮断できた
- [ ] 音切れ、ドリフト、顕著な遅延悪化がない

## 結果記録

```text
日時:
macOS:
ChatGPT app version:
Browser/version:
Meeting provider:
Headphones:
会議 -> ChatGPT: PASS / FAIL
ChatGPT -> 会議: PASS / FAIL
5分文脈: PASS / FAIL
15分文脈: PASS / FAIL / NOT RUN
呼び出しから発話開始まで: ___ 秒
意図しない発話回数: ___ 回
音声ループ: YES / NO
備考:
```

## 終了

- [ ] GPT参加者をミュートして退室させた
- [ ] ChatGPT Voiceを終了した
- [ ] システムの既定入力を元へ戻した
- [ ] システムの既定出力を元へ戻した
- [ ] テストで知り得た会議情報を、必要な保持方針に従って扱った
