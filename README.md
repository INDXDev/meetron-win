# Meeting Copilot

[![CI](https://github.com/bb8ad8/meeting-copilot/actions/workflows/ci.yml/badge.svg)](https://github.com/bb8ad8/meeting-copilot/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#動作環境)

ChatGPT Web Voiceを、Google Meetへ`GPT-Live`という別参加者として接続するmacOS向けの実験的ベータ版です。OpenAI APIは使わず、BlackHoleの仮想音声デバイスで会議音声とChatGPT音声を双方向に橋渡しします。

このプロジェクトは非公式であり、OpenAI、Google、Existential Audioの提供・承認を受けた製品ではありません。ChatGPTとGoogle Meetの画面変更により、自動化が動かなくなる可能性があります。

初回導入は、ローカルのファイルとターミナルを操作できるAIコーディング支援へセットアップを依頼する方法を推奨します。AIが環境診断とコマンド実行を担当し、管理者認証、再起動、Chromeの手動操作、アカウントへのログインなどは利用者が行います。詳しい役割分担は以下を参照してください。

## 動作環境

- macOS（CIはmacOS 14、実機はmacOS 26 / Apple Siliconで確認）
- Google Chrome公式ビルド
- Node.js 20以降、Homebrew、BlackHole 2ch / 16ch
- ChatGPT Web Voiceを利用できるアカウント
- Google Meetへ参加できるGoogleアカウント

Intel MacとmacOS 13以前では未検証です。Chrome Web Store版はなく、GitHubから取得した拡張をデベロッパーモードで読み込みます。

## 現在のスコープ

- Google Meetへの統合参加を自動化。Zoom Web Clientは低レベル起動のみ試験的に対応
- 会議URL、初回マイク案内、表示名、音声デバイス、参加前ミュートを自動設定
- ChatGPT Projectでの新規チャット作成とVoice開始を自動設定
- 拡張の`開始`と統合起動では参加リクエストまで自動化。低レベル起動では`--join`指定時のみ自動化
- 発話抑制はProject instructionsと会議側ミュートで行う
- 普段使うChromeのMeet上に表示する小型UIから、GPT参加者の接続確認、マイク、Voice、セッション終了、環境診断を遠隔操作

BlackHoleのバイナリやインストーラは、このリポジトリには同梱しません。

## 音声構成

```text
会議参加者の音声
  -> 専用ChromeのGPT参加者Meet
  -> Meet speaker: BlackHole 2ch
  -> macOS system input: BlackHole 2ch
  -> ChatGPT Voice input

ChatGPT Voice output
  -> ChatGPT VoiceタブだけをBlackHole 16chへ出力
  -> GPT参加者Meet mic: BlackHole 16ch
  -> Google Meet
  -> 通常ChromeのMeet
  -> 現在の物理出力（ヘッドホン／スピーカー）
```

ChatGPTから見て、`BlackHole 2ch`を入力経路、`BlackHole 16ch`を出力経路に分けることで、ChatGPTの発話が自分の入力へ戻るループを防ぎます。ChatGPT Voiceタブ以外の音声とmacOSのシステム出力は変更しません。

## AIアシスタントによる初回導入（推奨）

Meeting Copilotは、音声ドライバ、macOSの音声設定、2つのChrome環境、GoogleとChatGPTのログインを扱うPoCです。非エンジニアがREADMEのコマンドを順番に実行するのではなく、Codexなどローカル操作に対応したAIアシスタントへ導入を任せ、本人確認が必要な場面だけ利用者が操作することを想定しています。

### AIへ渡す依頼文

ローカル操作に対応したAIアシスタントを開き、次の依頼文を渡してください。すでにリポジトリを取得している場合は、そのフォルダをAIに開かせてから依頼します。

```text
https://github.com/bb8ad8/meeting-copilot のMeeting Copilotを、このMacで利用できる状態までセットアップしてください。

README.mdとdocs/getting-started.mdを先に読み、最初に環境診断と作業計画を示してください。AIが実行できるコマンド、設定、動作確認は自動で進めてください。

次の操作が必要になったら勝手に進めず、理由と操作内容を短く説明して私に依頼してください。
- BlackHoleのライセンス条件への同意
- macOS管理者パスワードまたはTouch ID
- macOSの再起動
- Chromeでのデベロッパーモード有効化と拡張機能の読み込み
- GoogleまたはChatGPTへのログインと2段階認証
- ChatGPT Projectの作成とInstructions設定
- テスト会議への参加、参加許可、音声確認

パスワードや認証コードをAIチャットへ入力するよう求めないでください。各工程の後に状態を再確認し、失敗した場合はログを調べてから次へ進んでください。
```

### AIと利用者の役割分担

| 工程 | AIが行うこと | 利用者が行うこと |
| --- | --- | --- |
| 取得・診断 | リポジトリの取得場所を特定または相談して取得し、macOS、Homebrew、Chrome、Node.js、音声デバイスを診断 | 保存場所と、AIへ許可する操作範囲を確認 |
| 依存ソフト | 実行内容を説明し、許可後にNode.jsパッケージや音声依存の導入を進行 | 外部ライセンスを読み、同意するか判断。管理者パスワードやTouch IDはmacOS画面へ直接入力 |
| 再起動 | 再起動前の作業を完了し、再開後に状態を再診断 | Macを再起動し、同じAIへ完了を伝える |
| Chrome拡張 | Native Messaging Hostを登録し、選択する正確な`extension`パスと画面を提示 | 普段使うChromeと専用Chromeでデベロッパーモードを有効化し、拡張を手動で読み込む |
| アカウント | 必要なGoogle、ChatGPT、Project画面を開き、完了後の状態を確認 | パスワードと2段階認証を各サービス画面へ直接入力し、Project Instructionsを確認 |
| 動作確認 | ローカルテスト、接続診断、ログ調査を実行 | テスト会議への参加・許可、参加者への通知、別端末での音声確認を実施 |

パスワードや認証コードをAIへ共有する必要はありません。管理者パスワードの入力待ちになった場合は、利用者がターミナルまたはmacOSの確認画面へ直接入力し、処理が終わったことだけをAIへ伝えます。

### 推奨する進め方

1. AIが環境診断とインストール内容の事前確認を行う
2. 利用者がライセンスを確認し、必要な管理者認証を行う
3. BlackHole導入後、利用者がmacOSを再起動する
4. 同じAIとの会話を開き、`再起動しました。続きから確認して`と伝える
5. AIの案内に沿って、利用者がChrome拡張、Google・ChatGPTログインを設定する
6. AIが診断とローカルテストを実行する
7. 利用者がテスト会議で最終確認する

画面ごとの詳しい操作は[インストールから初回利用まで](docs/getting-started.md)にあります。拡張を読み込んだ後は、不足している設定をポップアップのステップ形式UIでも確認できます。

## 手動セットアップ・開発者向け

以下は、AIアシスタントが内部で実行する主なコマンドと、手動で問題を切り分ける場合の参考手順です。通常の初回導入では、利用者がすべてを自分で実行する必要はありません。

```bash
./scripts/check-env.sh
./scripts/install-audio-deps.sh --dry-run
./scripts/install-audio-deps.sh --accept-blackhole-license
```

BlackHoleの導入後にmacOSを再起動し、[BlackHoleのセットアップ](docs/setup-blackhole.md)と[音声ルーティング](docs/audio-routing.md)を完了します。

### MeetコントロールUI

Google Meet上へ常駐する開発版Chrome拡張とNative Messaging Hostを設定します。

```bash
npm install
./scripts/install-control-ui.sh
```

普段使うChromeでデベロッパーモードを有効にし、`extension`ディレクトリを「パッケージ化されていない拡張機能」として読み込みます。初期セットアップから、MeetとChatGPTで共用する専用Chromeを開き、同じ拡張をそちらにも一度読み込みます。Chrome公式ビルドでは開発版拡張をコマンドだけで読み込めないため、このディレクトリ選択だけは手動です。詳しくは[MeetコントロールUI](docs/control-ui.md)を参照してください。

普段使うChromeで拡張を開くと、音声デバイス、ChatGPT Project、専用Chromeを順に確認する初期セットアップが表示されます。完了後はMeet URLを入力して`開始`を押すだけで、音声経路の設定、ChatGPT Voiceの起動、GPT参加者のMeet参加、マイク解除までをバックグラウンドで実行します。通常ChromeのMeet上に出るパネルは専用ChromeのGPT参加者だけを操作し、ユーザー本人のMeetマイクには触れません。

```bash
./scripts/open-gpt-participant.sh "https://meet.google.com/xxx-yyyy-zzz"
```

Google Meetのマイク権限、初回案内、表示名、BlackHoleデバイス、参加前ミュートを自動設定する場合:

```bash
npm install
./scripts/open-gpt-participant.sh --auto-prepare --restart-profile \
  "https://meet.google.com/xxx-yyyy-zzz"
```

自動設定は専用Chromeプロファイルだけを再起動し、`127.0.0.1`に限定したChrome DevTools接続を一時的に使います。この専用Chromeではメディア権限ダイアログを自動承認します。通常のChromeプロファイルには接続しません。`--join`を追加すると、Meetの検証準備を待ってから参加リクエストも送信します。

ChatGPTの`Meeting Copilot` Projectで毎回新しいチャットを作成し、Voiceを開始する場合:

```bash
./scripts/open-chatgpt-live.sh --restart-profile
```

初回だけ、Meetと共用する専用ChromeでChatGPTへログインし、同じコマンドを再実行します。Project URLはローカル専用の`.meeting-copilot.env`へ保存し、リポジトリ配布には含めません。ChatGPT Webの入力はシステム既定の`BlackHole 2ch`を使い、専用Chrome内のVoice出力だけを`BlackHole 16ch`へ固定します。macOSのシステム出力は変更しません。

ChatGPT Voiceを開始し、Meetの参加リクエストまでまとめて実行する場合:

```bash
./scripts/start-meeting-copilot.sh \
  "https://meet.google.com/xxx-yyyy-zzz"
```

統合起動では、同じ専用Chromeの別タブでChatGPT VoiceとMeetを開き、入室後に会議マイクも自動解除します。Voice再起動はChatGPTタブだけを作り直すため、Meet参加状態を維持します。低レベルの`open-gpt-participant.sh --join`だけを実行した場合はミュートのままです。`--join`を使う場合は専用ChromeでGoogleへ一度ログインしてください。

参加ボタン表示後の固定待機は既定で2秒です。必要な場合は`MEETING_COPILOT_JOIN_DELAY`で調整できます。MeetのUIからマイクボタンを検出できない場合は、標準ショートカットへ自動的にフォールバックします。カメラ状態を安全に判定できないUIでは参加ボタンを自動で押さず、専用Chromeを前面に残すので、カメラをオフにして手動参加してください。

会議中にGPT参加者のマイクをローカルから制御する場合:

```bash
./scripts/set-meet-mic.sh mute
./scripts/set-meet-mic.sh unmute
./scripts/set-meet-mic.sh toggle
```

常駐パネルの`終了・復元`は、GPT参加者のミュート、ChatGPT Voice停止、Meet退出、専用Meetタブの終了、起動前に保存したmacOS入出力への復元をまとめて実行します。音声設定だけを復元する場合は次のコマンドを使います。

```bash
./scripts/restore-audio.sh
```

2026年7月以降のChatGPTデスクトップアプリにもVoiceがありますが、クラウドProjectを外部から選択してVoiceを開始する公開APIはありません。このPoCでは、自動化可能で今回の実機テストが通ったChatGPT Web Voiceを利用します。

ChatGPT側は[Project設定](docs/chatgpt-project.md)、動作確認は[検証チェックリスト](docs/verification.md)に従ってください。

## アンインストール

専用Chromeを終了してから、Native Messaging Host登録を削除します。

```bash
./scripts/uninstall.sh
```

専用Chromeプロファイル、ローカル設定、実行ログも削除する場合:

```bash
./scripts/uninstall.sh --remove-data --yes
```

保存していたmacOS音声設定を復元できない場合、アンインストールは中止され、復旧データは削除されません。元の音声デバイスを再接続してから再実行してください。最後に、普段使うChromeの`chrome://extensions`からMeeting Copilot Controlsを削除します。`--remove-data`を使わない場合は、専用Chromeからも同じ拡張を削除してください。詳しくは[MeetコントロールUI](docs/control-ui.md#アンインストール)を参照してください。

## 開発用チェック

```bash
./tests/scripts-test.sh
```

不具合報告では、macOSとChromeのバージョン、再現手順、`.meeting-copilot-runtime/meeting-launch.log`からアカウント情報や会議URLを除いた内容を[Issue](https://github.com/bb8ad8/meeting-copilot/issues)へ添えてください。修正提案は[CONTRIBUTING.md](CONTRIBUTING.md)に従ってください。セキュリティ上の問題は公開Issueへ書かず、[SECURITY.md](SECURITY.md)の連絡方法を利用してください。

## 配布上の注意

Meeting Copilotは[GNU General Public License v3.0](LICENSE)で提供します。BlackHoleはリポジトリへ同梱せず、利用者が上流のライセンス条件を確認して直接導入します。Playwrightなど外部依存のライセンスは各パッケージに従います。

本ソフトウェアは実験的な自動化ツールであり、会議への参加、録音、要約、判断の正確性や継続動作を保証しません。本番会議へ導入する前に、機密情報を含まない会議で確認してください。

会議音声をChatGPTへ送る前に、所属組織の規定と参加者への通知・同意要件を確認してください。

データの扱いは[PRIVACY.md](PRIVACY.md)、脆弱性の報告は[SECURITY.md](SECURITY.md)、開発参加は[CONTRIBUTING.md](CONTRIBUTING.md)を参照してください。
