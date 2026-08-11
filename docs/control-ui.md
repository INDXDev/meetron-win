# MeetコントロールUI

## 構成

コントロールUIは、Google Meetへ読み込むManifest V3拡張と、macOS上で動くNative Messaging Hostで構成します。

```text
Regular Chrome Meet controller
  -> Chrome extension service worker
  -> Native Messaging
  -> scripts/native-host.mjs
  -> dedicated GPT Meet / ChatGPT Voice / check-env.sh / SwitchAudioSource
```

拡張機能は会議音声や字幕を保存・送信しません。普段使うChromeのMeetページではコントローラー表示だけを行い、ユーザー本人のマイクボタンは操作しません。GPT参加者の状態取得とマイク操作はNative Hostから専用Chromeへ接続して行います。Native Hostは許可済みの固定コマンドだけを受け付け、任意のシェルコマンドは実行しません。

## 初回セットアップ

リポジトリの依存関係とNative Messaging Hostを準備します。

```bash
npm install
./scripts/install-control-ui.sh
```

まず普段使うChromeの`chrome://extensions`で次を行います。

1. `デベロッパー モード`をオンにする
2. `パッケージ化されていない拡張機能を読み込む`を選ぶ
3. リポジトリ内の`extension`ディレクトリを選ぶ
4. 拡張IDが`jlikakgdldiihhflkobhnpfegjlcakdd`であることを確認する
5. Meeting Copilot Controlsをツールバーへ固定する

初期セットアップの`専用Chrome設定を開く`を押し、開いた専用Chromeにも同じ手順で拡張を読み込みます。直接開く場合は次を実行します。

```bash
./scripts/open-control-ui-setup.sh
```

Chrome 137以降の公式ビルドでは`--load-extension`が削除されているため、この初回操作は自動化できません。一度読み込めば、同じ専用Chromeプロファイルに保持されます。

拡張を開くとNative Hostへ接続し、設定状況を確認します。不足がある場合は次の4ステップがポップアップ内に自動表示されます。

1. Native Messaging Hostとのローカル接続
2. BlackHoleと`Meeting Copilot Output`、現在の音声経路
3. ChatGPT Project URLと専用ChatGPTログイン
4. Meet専用Chromeの拡張読込とGoogleログイン

音声デバイス、Project URL、専用Chromeの拡張読込は自動判定します。ChatGPTとGoogleのログインは外部状態を保存しないため、専用Chromeで確認後に利用者がチェックします。完了後もMeet URL入力画面右上の設定ボタンから再度開けます。

## 利用方法

ChromeツールバーでMeeting Copilot Controlsを開きます。

1. Google Meet URLを入力する
2. `開始`を押す
3. ChatGPT Voiceの起動とMeetへの参加が完了するまで待つ

設定が未完了なら先にセットアップ画面が表示され、Meet URL入力へは進みません。統合起動時は音声経路も自動的に設定します。

最後に使ったURLは普段使うChromeの拡張ストレージへ保存され、次回起動時に復元されます。開始後に専用Chromeが再起動しても、ローカルの起動ジョブは継続します。進行状況とエラーの詳細は`.meeting-copilot-runtime/meeting-launch.log`へ記録されます。

参加前の固定待機は2秒です。Meet側の読み込みが遅い環境では、`.meeting-copilot.env`の`MEETING_COPILOT_JOIN_DELAY`で秒数を増やせます。

端末からの起動も引き続き利用できます。

```bash
./scripts/start-meeting-copilot.sh "https://meet.google.com/xxx-yyyy-zzz"
```

普段使うChromeのMeet画面右下にコントロールが表示されます。パネルはドラッグ移動と折りたたみが可能で、位置は通常Chromeの拡張ストレージへ保存されます。

利用できる操作:

- Meet接続状態、ChatGPT Voice、音声経路の確認
- GPT参加者のミュートとミュート解除
- GPT参加者のミュート、ChatGPT Voice停止、macOS音声設定の復元をまとめたセッション終了
- 新しいProjectチャットでVoiceを再起動
- `check-env.sh`による環境診断

ツールバーに見つからない場合は、Chromeの拡張機能メニューからMeeting Copilot Controlsを固定します。

マイク操作は常にNative Host経由で専用ChromeのGPT参加者へ送られます。表示中の通常Chromeのマイクボタンをクリックするフォールバックはありません。最後に成功したGPT参加者の状態は会議URLごとにローカル保存されるため、専用Chromeが一時的に状態を公開しない画面でもボタンは`ミュート`または`ミュート解除`を表示します。

## 更新

GitHubから更新を取得した後、`chrome://extensions`でMeeting Copilot Controlsの再読み込みボタンを押します。リポジトリの移動後は、Native Hostの絶対パスを更新するため次を再実行します。

```bash
./scripts/install-control-ui.sh
```

## トラブルシューティング

### ローカルホストへ接続できない

```bash
./scripts/install-control-ui.sh
./scripts/check-env.sh
```

拡張IDとNative Host manifestの`allowed_origins`が一致しているか確認します。

インストーラーは、通常のGoogle Chrome登録先と`MEETING_COPILOT_PROFILE_DIR`で指定した専用Chrome直下の`NativeMessagingHosts`へ登録します。専用プロファイルを変更した場合は、環境変数を指定した状態でインストーラーを再実行してください。

### UIが表示されない

1. 普段使うChromeの`chrome://extensions`を開く
2. Meeting Copilot Controlsが有効か確認する
3. 拡張機能の再読み込みボタンを押す
4. 普段使うChromeのMeetページを再読み込みする

専用Chrome側のGPT参加者を検出できない場合は、専用Chromeでも同じ拡張が有効か確認します。

### 緊急ミュート

UIを操作できない場合も、端末から停止できます。

```bash
./scripts/set-meet-mic.sh mute
```

## アンインストール

`chrome://extensions`から拡張機能を削除し、Native Host登録を削除します。

```bash
./scripts/install-control-ui.sh --uninstall
```

専用Chromeのプロファイル、ローカル設定、実行ログも削除する場合は、Chromeを終了してから次を実行します。この操作はChatGPTとGoogleの専用ログイン状態も削除します。

```bash
./scripts/uninstall.sh --remove-data --yes
```
