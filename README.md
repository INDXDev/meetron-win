# Meeting Copilot

ChatGPT Web Voiceを、Google Meetへ`GPT-Live`という別参加者として接続するmacOS向けPoCです。OpenAI APIは使わず、BlackHoleの仮想音声デバイスで会議音声とChatGPT音声を双方向に橋渡しします。

このプロジェクトは非公式であり、OpenAI、Google、Existential Audioの提供・承認を受けた製品ではありません。ChatGPTとGoogle Meetの画面変更により、自動化が動かなくなる可能性があります。

初めて導入する場合は、[インストールから初回利用まで](docs/getting-started.md)を参照してください。拡張を読み込んだ後は、不足している設定をポップアップのステップ形式UIが案内します。

## 現在のスコープ

- macOS専用
- Google Meetへの統合参加を自動化。Zoom Web Clientは低レベル起動のみ試験的に対応
- Google Chrome、Node.js、BlackHoleは外部依存
- 会議URL、初回マイク案内、表示名、音声デバイス、参加前ミュートを自動設定
- ChatGPT Projectでの新規チャット作成とVoice開始を自動設定
- 会議への参加リクエストは明示的な`--join`指定時のみ自動化
- 発話抑制はProject instructionsと会議側ミュートで行う
- 普段使うChromeのMeet上に表示する小型UIから、GPT参加者の接続確認、マイク、Voice、環境診断を遠隔操作

BlackHoleのバイナリやインストーラは、このリポジトリには同梱しません。

## 音声構成

```text
会議参加者の音声
  -> GPT参加者のspeaker: BlackHole 2ch
  -> ChatGPT Voice input

ChatGPT Voice output
  -> Multi-Output Device: headphones + BlackHole 16ch
  -> GPT参加者のmic: BlackHole 16ch
  -> 会議
```

`BlackHole 2ch`を入力経路、`BlackHole 16ch`を出力経路に分けることで、ChatGPTの発話が自分の入力へ戻るループを防ぎます。

## クイックスタート

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

普段使うChromeでデベロッパーモードを有効にし、`extension`ディレクトリを「パッケージ化されていない拡張機能」として読み込みます。拡張の初期セットアップからMeet専用Chromeを開き、同じ拡張をそちらにも一度読み込みます。Chrome公式ビルドでは開発版拡張をコマンドだけで読み込めないため、このディレクトリ選択だけは手動です。詳しくは[MeetコントロールUI](docs/control-ui.md)を参照してください。

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

初回だけ専用ChromeでChatGPTへログインし、同じコマンドを再実行します。Project URLはローカル専用の`.meeting-copilot.env`へ保存し、リポジトリ配布には含めません。ChatGPT Webの入力はシステム既定の`BlackHole 2ch`、出力は`Meeting Copilot Output`を使います。

ChatGPT Voiceを開始し、Meetの参加リクエストまでまとめて実行する場合:

```bash
./scripts/start-meeting-copilot.sh \
  "https://meet.google.com/xxx-yyyy-zzz"
```

統合起動では入室後に会議マイクも自動解除し、Project instructionsでChatGPTの発話を制御します。低レベルの`open-gpt-participant.sh --join`だけを実行した場合は、従来どおりミュートのままです。Googleは匿名ユーザーや第三者ボットの自動ノックを拒否するため、`--join`を使う場合はMeet専用ChromeプロファイルでGoogleへ一度ログインしてください。安定運用では、そのアカウントをCalendarの参加者へ追加します。

参加ボタン表示後の固定待機は既定で2秒です。必要な場合は`MEETING_COPILOT_JOIN_DELAY`で調整できます。MeetのUIからマイクボタンを検出できない場合は、標準ショートカットへ自動的にフォールバックします。

会議中にGPT参加者のマイクをローカルから制御する場合:

```bash
./scripts/set-meet-mic.sh mute
./scripts/set-meet-mic.sh unmute
./scripts/set-meet-mic.sh toggle
```

常駐パネルの`終了・復元`、または次のコマンドで、起動前に保存したmacOSの入出力へ戻せます。

```bash
./scripts/restore-audio.sh
```

2026年7月以降のChatGPTデスクトップアプリにもVoiceがありますが、クラウドProjectを外部から選択してVoiceを開始する公開APIはありません。このPoCでは、自動化可能で今回の実機テストが通ったChatGPT Web Voiceを利用します。

ChatGPT側は[Project設定](docs/chatgpt-project.md)、動作確認は[検証チェックリスト](docs/verification.md)に従ってください。

## 開発用チェック

```bash
./tests/scripts-test.sh
```

## 配布上の注意

Meeting Copilotは[GNU General Public License v3.0](LICENSE)で提供します。BlackHoleはリポジトリへ同梱せず、利用者が上流のライセンス条件を確認して直接導入します。Playwrightなど外部依存のライセンスは各パッケージに従います。

会議音声をChatGPTへ送る前に、所属組織の規定と参加者への通知・同意要件を確認してください。

データの扱いは[PRIVACY.md](PRIVACY.md)、脆弱性の報告は[SECURITY.md](SECURITY.md)、開発参加は[CONTRIBUTING.md](CONTRIBUTING.md)を参照してください。
