# GPT-Live Meeting Bridge Implementation Plan

作成日: 2026-08-11

## 1. BlackHoleの配布形態とライセンス確認

### 確認結果

BlackHoleはPoCの外部依存として利用可能と判断する。ただし、商用プロダクトへの同梱・再配布・改変配布は別途確認が必要。

根拠:

- BlackHole公式GitHubは、BlackHoleをmacOSのアプリ間音声ループバックドライバとして説明している。
  - https://github.com/ExistentialAudio/BlackHole
- 公式READMEには、送信アプリの出力をBlackHoleにし、受信アプリの入力をBlackHoleにするルーティング手順が記載されている。
  - https://github.com/ExistentialAudio/BlackHole
- 公式LICENSEでは、BlackHoleのソースコードはGNU GPLv3、公式コンパイル済みバイナリとインストーラはExistential Audio Inc.の著作物でAll rights reservedと明記されている。
  - https://github.com/ExistentialAudio/BlackHole/blob/master/LICENSE
- 公式READMEには「A license is required for all non-GPLv3 projects」と記載されている。
  - https://github.com/ExistentialAudio/BlackHole
- Homebrew Caskでは`blackhole-2ch`、`blackhole-16ch`、`blackhole-64ch`が提供されている。`brew info blackhole-2ch`では、`BlackHole2ch-0.7.1.pkg`をインストールし、再起動が必要と表示される。

### PoCでの扱い

PoCではBlackHoleを「同梱」ではなく「ユーザー環境へHomebrewでインストールする外部依存」とする。

許容する:

- 開発者のローカル環境でのインストール
- 検証手順書にHomebrewコマンドを記載
- `blackhole-2ch`と`blackhole-16ch`を利用した音声ルーティング検証

避ける:

- アプリ配布物にBlackHoleの公式pkgを同梱する
- BlackHoleの改変版を独自ブランドで配布する
- プロプライエタリ製品に組み込んだ形で配布する

商用化前の判断:

- GPLv3として製品全体を扱えるならソース利用の可能性を検討する
- 非GPLv3/商用プロダクトならExistential Audioにライセンス確認する
- 最終的には自前CoreAudio HALドライバへ置き換える選択肢を残す

これは法務判断ではないため、外部配布前に必ずライセンスレビューを行う。

## 2. 目的

ChatGPTデスクトップアプリのGPT-Live Voiceを、ZoomまたはGoogle Meetの会議にローカル参加させるPoCを作る。

API未提供のGPT-Liveを直接呼び出すのではなく、ChatGPTアプリを既存のGUIアプリとして扱い、仮想音声デバイスと会議クライアントを介して会議に参加させる。

## 3. 基本方針

最初のPoCは「GPT-Liveを別参加者として会議に入れる」構成を本線にする。

理由:

- ユーザー本人のマイクとGPTの発話を1つのZoom/Meet入力へミックスする必要がない
- ユーザーは通常どおり会議参加できる
- GPT側は別ブラウザプロファイルや別Zoom Web参加として、参加者名を`GPT-Live`にできる
- 「ユーザーを招待する」体験に近い
- Zoom/Meet APIを使わずに検証できる

## 4. 推奨PoCアーキテクチャ

```text
User participant
  - Zoom/Meetに通常参加
  - speaker: headphones
  - microphone: physical mic

GPT participant
  - Zoom/Meetに別参加
  - speaker/output: BlackHole 2ch
  - microphone/input: BlackHole 16ch

ChatGPT desktop app
  - voice input: BlackHole 2ch
  - voice output: system output -> Multi-Output Device -> BlackHole 16ch + headphones
```

音声の流れ:

```text
Meeting audio from others
  -> GPT participant speaker
  -> BlackHole 2ch
  -> ChatGPT Voice input

ChatGPT Voice output
  -> System output / Multi-Output Device
  -> BlackHole 16ch
  -> GPT participant microphone
  -> Meeting
```

この構成では、ユーザー本人の通常会議参加とGPT参加者を分離する。GPTの発話は「GPT-Live」という別参加者の音声として会議に出る。

## 5. 必要依存

必須:

- macOS
- ChatGPTデスクトップアプリ
- Homebrew
- BlackHole 2ch
- BlackHole 16ch
- ChromeまたはChromium系ブラウザ
- ZoomまたはGoogle Meet

推奨:

- `switchaudio-osx`
  - CLIで既定入出力を切り替えるため
- Chrome専用プロファイル
  - GPT参加者用のブラウザ状態をユーザー通常参加と分けるため

インストール例:

```bash
brew install --cask blackhole-2ch
brew install --cask blackhole-16ch
brew install switchaudio-osx
```

BlackHoleインストール後は再起動が必要。

## 6. ChatGPTプロジェクト設定

ChatGPT側では専用Projectを作成し、Project instructionsに会議参加用プロンプトを入れる。

OpenAI Help Centerでは、ChatGPT Projectsにproject instructionsを追加できることが説明されている。

- https://help.openai.com/en/articles/10169521-projects-in-chatgpt

さらに、ChatGPT VoiceのリリースノートではGPT-Live in ChatGPT VoiceがProjectsとproject instructionsを参照できる旨が記載されている。

- https://help.openai.com/en/articles/6825453-chatgpt-release-notes

推奨Project名:

```text
Meeting Copilot
```

Project instructions:

```text
あなたは会議に参加する助言者です。

会議中の発言を聞き、文脈、論点、未解決事項、意思決定の流れを静かに把握してください。

ただし「ChatGPTどう思う？」「GPTどう思う？」「GPT-Liveどう思う？」のように明示的に呼ばれるまで、自分から発話しないでください。

呼ばれた場合のみ、直前までの議論を踏まえて、30秒以内で以下の順に話してください。

1. 現在の論点
2. 見落とされていそうなリスクまたは前提
3. 次に取るべき具体的な提案

会議を遮らないでください。
不確かな点は断定せず、必要なら「ここは確認が必要です」と短く述べてください。
```

注意:

- 発話抑制は100%保証しない前提
- PoCではプロンプト制御のみでよい
- 次段階ではGPT参加者側の仮想マイクをミュート/アンミュートする外側制御を追加する

## 7. Zoom/Meet参加方式

### Phase A: 手動参加

最初はAPIを使わない。

手順:

1. ユーザーが通常のZoom/Meetに参加する
2. GPT参加者用Chromeプロファイルを開く
3. 同じ会議URLを開く
4. 名前を`GPT-Live`にする
5. GPT参加者のマイクを`BlackHole 16ch`にする
6. GPT参加者のスピーカーを`BlackHole 2ch`にする
7. ChatGPTデスクトップアプリでMeeting Copilot Projectを開く
8. Voiceを開始し、入力を`BlackHole 2ch`へ接続する

### Phase B: ブラウザ自動操作

PlaywrightまたはAppleScriptでGPT参加者用ブラウザを起動する。

対象:

- Google Meet: Chrome profileを指定してURL起動
- Zoom: Zoom Web Clientを優先。必要に応じてZoom desktop clientを補助

やること:

- 会議URLを受け取る
- GPT参加者用プロファイルで開く
- 表示名を`GPT-Live`に設定
- マイク/スピーカー選択を補助
- 入室待ち状態を検出

### Phase C: 公式API/SDK対応

本番化の段階で検討する。

Zoom:

- Zoom RTMSはリアルタイム会議データへのアクセスを提供する。Zoom公式ページでは音声、映像、チャット、画面共有データの低遅延WebSocket伝送に言及している。
  - https://www.zoom.com/en/realtime-media-streams/
- Meeting SDKやRTMSでより正式な統合を検討する。

Google Meet:

- Meet Media APIはGoogle Meet会議のリアルタイム音声/映像アクセスを提供する。
  - https://developers.google.com/workspace/meet/media-api/guides/overview
- ただしDeveloper Preview、OAuth、restricted scopes、管理者/参加者同意などの制約がある。
  - https://developers.google.com/workspace/meet/media-api/guides/get-started

PoCではAPI/SDKよりもローカル別参加者方式を優先する。

## 8. 実装タスク

### M1: 環境検出CLI

作るもの:

- `scripts/check-env.sh`

確認項目:

- macOSバージョン
- Homebrew有無
- BlackHole 2ch/16chの有無
- `SwitchAudioSource`有無
- ChatGPTアプリ有無
- Chrome有無
- 現在の音声デバイス一覧

出力:

- 不足依存
- 次に実行すべきコマンド

### M2: 依存セットアップ手順

作るもの:

- `docs/setup-blackhole.md`
- `scripts/install-audio-deps.sh`

やること:

- Homebrewがある場合のみBlackHoleとswitchaudio-osxを導入
- インストール後に再起動が必要なことを表示
- ライセンス注意事項を表示

### M3: macOS音声設定手順

作るもの:

- `docs/audio-routing.md`

手動設定:

- Audio MIDI SetupでMulti-Output Deviceを作る
- `BlackHole 16ch + headphones`を含める
- drift correctionを必要に応じて設定
- GPT参加者のspeakerを`BlackHole 2ch`へ設定
- GPT参加者のmicを`BlackHole 16ch`へ設定
- ChatGPT Voiceの入力が`BlackHole 2ch`を拾う状態にする

注:

- macOS標準機能だけでは任意アプリの音声を完全自動ルーティングできない
- Zoom/Meet側に入出力選択UIがあるため、まずそこを使う

### M4: GPT参加者ランチャー

作るもの:

- `scripts/open-gpt-participant.sh`

入力:

```bash
./scripts/open-gpt-participant.sh "https://meet.google.com/xxx-yyyy-zzz"
./scripts/open-gpt-participant.sh "https://zoom.us/j/..."
```

やること:

- Chromeの専用profile directoryを使う
- 会議URLを開く
- 可能なら表示名を`GPT-Live`に固定する
- 初回はユーザーにマイク/スピーカー選択を促す

### M5: ChatGPT Project運用手順

作るもの:

- `docs/chatgpt-project.md`

内容:

- Project作成手順
- Project instructions
- Voice開始手順
- 初回テスト用の会議シナリオ
- うまく黙らない場合のプロンプト修正例

### M6: 検証チェックリスト

作るもの:

- `docs/verification.md`

検証項目:

- GPT参加者が会議に入れる
- GPT参加者のスピーカー音がChatGPTに届く
- ChatGPT出力がGPT参加者マイクとして会議に届く
- GPTが会議文脈を理解する
- 「ChatGPTどう思う？」で応答する
- 応答レイテンシが許容範囲
- GPT音声がChatGPT入力へループしない
- ユーザー本人の会議体験に支障がない

### M7: ミュート制御

PoC後半で追加する。

候補:

- GPT参加者側の会議マイクを手動ミュート
- ブラウザ自動操作でミュート/アンミュート
- `ChatGPTどう思う？`の音声検出は最初は行わず、ユーザー操作で解除

将来:

- ローカルwake phrase detector
- GPT参加者のマイクを呼び出し時だけ開く
- ChatGPTの勝手な発話が会議へ出ないよう外側で止める

## 9. リスク

### ChatGPTアプリ制御

ChatGPTデスクトップアプリのVoice入出力選択を外部から完全制御できない可能性がある。

対策:

- システム既定出力を利用する
- 必要な設定は手動手順として固定する
- 自動化は補助扱いにする

### 音声ループ

ChatGPT出力が再びChatGPT入力に戻ると会議が壊れる。

対策:

- Meeting audio用に`BlackHole 2ch`
- GPT output用に`BlackHole 16ch`
- 2つの仮想デバイスを分離する

### 会議アプリのデバイス選択

Zoom/MeetのUI変更で自動化が壊れる。

対策:

- 初期PoCは手動設定
- 自動化はChrome profile起動とURL投入までを優先
- デバイス選択はチェックリスト化

### ライセンス

BlackHoleを同梱配布するとGPLv3/商用ライセンスの論点が出る。

対策:

- PoCはHomebrew外部依存
- 配布前にExistential Audioへ確認
- 製品版では自前CoreAudio HALドライバを検討

## 10. 成功条件

PoC成功の最低条件:

- ZoomまたはMeetで`GPT-Live`という別参加者を入室させられる
- 会議の発話がChatGPT Voiceへ届く
- ChatGPT Voiceの発話が会議参加者へ聞こえる
- 5分以上の会議文脈を踏まえて質問に答えられる
- 音声ループが発生しない

次段階へ進む条件:

- 15分以上の会議で文脈追跡が実用的
- 入出力設定が手順化できる
- GPTの発話タイミングが許容できる
- ZoomとMeetのどちらか一方で安定動作する

## 11. 別セッションへの依頼文

次のセッションでは、以下を実装する。

```text
このリポジトリでGPT-Live Meeting BridgeのPoCを作ってください。

前提:
- macOS専用
- ChatGPTデスクトップアプリのGPT-Live Voiceを使う
- OpenAI APIは使わない
- BlackHoleは同梱せず、Homebrew外部依存として扱う
- blackhole-2chとblackhole-16chを使う
- GPTはZoom/Meetに別参加者として参加させる

作るもの:
- scripts/check-env.sh
- scripts/install-audio-deps.sh
- scripts/open-gpt-participant.sh
- docs/setup-blackhole.md
- docs/audio-routing.md
- docs/chatgpt-project.md
- docs/verification.md

最初のゴール:
- Google MeetまたはZoomの会議URLを渡すと、GPT参加者用Chromeプロファイルで会議を開ける
- 音声ルーティングの手動設定手順が明確
- ChatGPT Project instructionsが用意されている
- 検証チェックリストに沿ってローカルで動作確認できる
```
