# インストールから初回利用まで

このガイドは、GitHubからMeeting Copilotを取得したmacOSユーザーが、Google Meetで`GPT-Live`を利用できるようになるまでの手順です。Chrome Web Storeは使わず、拡張機能をデベロッパーモードで読み込みます。

## 1. 必要なもの

- macOS
- Google Chrome
- Homebrew
- Node.jsとnpm
- 有線またはUSBヘッドホンを推奨
- Voiceを利用できるChatGPTアカウント
- Google Meetへ参加できるGoogleアカウント
- テスト用のGoogle Meetと、音声確認用の別端末

ChatGPTデスクトップアプリは必須ではありません。このシステムは専用Chromeプロファイル内のChatGPT Web Voiceを使います。

会議音声をChatGPTへ送る前に、所属組織の規定を確認し、参加者へAI参加者と音声処理について必要な通知を行ってください。

## 2. リポジトリと依存関係を準備する

```bash
git clone https://github.com/bb8ad8/meeting-copilot.git
cd meeting-copilot
npm install
```

Node.jsがない場合は、先に`brew install node`を実行します。

BlackHoleのライセンス注意事項と実行内容を確認してから、音声依存を導入します。

```bash
./scripts/install-audio-deps.sh --dry-run
./scripts/install-audio-deps.sh --accept-blackhole-license
```

インストール後にmacOSを再起動します。

## 3. 普段使うChromeへ拡張を登録する

次のコマンドでNative Messaging Hostを登録します。

```bash
./scripts/install-control-ui.sh
```

普段使うChromeで`chrome://extensions`を開き、次を1回だけ行います。

1. `デベロッパー モード`をオンにする
2. `パッケージ化されていない拡張機能を読み込む`を押す
3. このリポジトリの`extension`ディレクトリを選ぶ
4. 拡張IDが`jlikakgdldiihhflkobhnpfegjlcakdd`であることを確認する
5. 拡張機能メニューからMeeting Copilot Controlsを固定する

この拡張がコントローラーです。普段使うChromeでメインのMeetへ参加し、そのMeet上の常駐パネルから専用ChromeのGPT参加者を操作します。ユーザー本人のMeetマイクは操作しません。

Chrome公式ビルドでは開発版拡張の読込をコマンドだけで完結できないため、ディレクトリ選択は手動です。ポップアップに`ローカルホスト未接続`と表示された場合は、リポジトリで`npm install && ./scripts/install-control-ui.sh`を実行してから再確認します。

## 4. ポップアップのセットアップを進める

ツールバーのMeeting Copilot Controlsを開きます。設定が不足している場合は、Meet URL入力画面の代わりに初期セットアップが自動表示されます。

バージョン0.5以前から更新した場合は、従来のMeet用プロファイルを共通プロファイルとして引き継ぐため、拡張とGoogleログインは維持されます。ChatGPTは同じ共通プロファイルで一度ログインし直してください。旧`ChatGPTVoiceChrome`は自動削除されず、`./scripts/uninstall.sh --remove-data --yes`を実行した場合に削除されます。

### ステップ1: ローカル連携

拡張とNative Messaging Hostの接続を確認します。未接続なら表示されたコマンドをリポジトリの場所に合わせて実行し、`接続を再確認`を押します。

### ステップ2: 音声デバイス

画面に従い、`BlackHole 2ch`、`BlackHole 16ch`、`Meeting Copilot Output`を確認します。`Meeting Copilot Output`がない場合は`Audio MIDI設定`を開き、次の構成でMulti-Output Deviceを作成します。

1. 左下の`+`から`Create Multi-Output Device`を選ぶ
2. 名前を`Meeting Copilot Output`に変更する
3. ヘッドホンと`BlackHole 16ch`だけを選ぶ
4. 2chの物理出力をPrimary Deviceにする
5. 必要に応じてBlackHole側のDrift Correctionを有効にする
6. 可能なら両方を`48.0 kHz`にそろえる

`BlackHole 2ch`はこのMulti-Output Deviceへ含めないでください。ChatGPTが自分の発話へ反応する音声ループの原因になります。

作成後に`状態を再確認`し、`音声経路を設定`を押します。入力が`BlackHole 2ch`、出力が`Meeting Copilot Output`へ切り替わります。詳しくは[BlackHoleセットアップ](setup-blackhole.md)と[音声ルーティング](audio-routing.md)を参照してください。

### ステップ3: 専用Chrome

`専用Chrome設定を開く`を押します。このChromeプロファイルを、GPT参加者のMeetとChatGPT Voiceの両方で共用します。

開いた`chrome://extensions`でデベロッパーモードを有効にし、画面に表示されたパスの`extension`ディレクトリを読み込みます。この専用ChromeでGoogleへログインし、`専用ChromeでGoogleへログイン済み`をチェックします。

自動参加を安定させるには、このGoogleアカウントをテスト会議またはCalendar予定の参加者へ追加してください。専用Chromeと普段使うChromeで同じGoogleアカウントを使う必要はありません。

### ステップ4: ChatGPT

ChatGPT Webで`Meeting Copilot` Projectを作成し、[ChatGPT Project設定](chatgpt-project.md)のProject instructionsを設定します。

Projectを開いたURLを入力して保存します。形式は次のとおりです。

```text
https://chatgpt.com/g/g-p-PROJECT_ID/project
```

`同じ専用ChromeでChatGPTを開く`を押してログインします。対象Projectへアクセスできることを確認し、ポップアップの`専用ChromeでChatGPTへログイン済み`をチェックします。Project URLはGit対象外の`.meeting-copilot.env`へ保存されます。

全項目が揃うと`セットアップ完了`が表示されます。後から見直す場合は、Meet URL入力画面右上の設定ボタンを押します。以前に正常起動まで完了したユーザーは、その実績を引き継いでMeet URL入力画面から開始します。

## 5. 初回テストを行う

最初は機密情報を扱わないテスト会議を使い、別のPCまたはスマートフォンも参加させます。

1. 普段使うChromeでテストMeetへ参加する
2. 拡張のポップアップへ同じ`https://meet.google.com/xxx-xxxx-xxx`形式のURLを入力する
3. `開始`を押す
4. 専用Chrome内でChatGPT VoiceタブとMeetタブが開くまで待つ
5. 必要ならMeet主催者側で`GPT-Live`の参加を許可する
6. 普段使うChromeのMeet右下にあるパネルでGPT参加者、ChatGPT Voice、音声経路を確認する

起動時にも音声経路が自動設定され、ChatGPT Projectに毎回新しいチャットが作成されます。Meet参加後はGPT参加者のマイクが自動解除されます。

パネルのマイクボタンは押した後の動作を表示します。

- `ミュート`: GPT参加者をミュートする
- `ミュート解除`: GPT参加者のミュートを解除する

次に[ローカル検証チェックリスト](verification.md)を使って、会議からChatGPT、ChatGPTから会議、音声ループ、呼び出し応答を順に確認します。

## 6. 毎回の利用

初回設定後は端末から起動する必要はありません。

1. ヘッドホンを接続する
2. 普段使うChromeでMeetへ参加する
3. 普段使うChromeの拡張へMeet URLを入力して`開始`を押す
4. 同じMeet上の常駐パネルでGPT参加者の状態を確認する

開始時にシステム入力を`BlackHole 2ch`、出力を`Meeting Copilot Output`へ切り替え、変更前のデバイスをローカルへ保存します。常駐パネルでは専用ChromeのGPT参加者マイク、ChatGPT Voiceの再起動、セッション終了、環境診断を操作できます。パネルはユーザー本人のマイクボタンを直接操作しません。

`Voice再起動`は専用Chrome全体を再起動せず、ChatGPTタブだけを閉じて新しいVoiceタブを作ります。Meet参加者は同じ会議に残ります。

## 7. 終了する

1. 常駐パネルの`終了・復元`を押す
2. GPT参加者をMeetから退出させる

```bash
./scripts/restore-audio.sh
```

## 8. トラブルシューティング

### Specified native messaging host not found

```bash
./scripts/open-control-ui-setup.sh
```

その後、`chrome://extensions`で拡張を再読み込みします。

### セットアップが次へ進まない

赤く表示された未完了項目を確認し、各画面の`状態を再確認`を押します。ログイン項目は専用Chromeでのログイン完了後にチェックを入れます。

### 起動に失敗する

```bash
./scripts/check-env.sh
tail -100 .meeting-copilot-runtime/meeting-launch.log
```

Project URL、ChatGPTとGoogleへのログイン、音声デバイス名を確認します。

### 音声ループが起きる

直ちに常駐パネルでGPT参加者をミュートします。`Meeting Copilot Output`へ`BlackHole 2ch`が含まれていないことを確認してください。

### 拡張を更新する

```bash
git pull
npm install
./scripts/install-control-ui.sh
```

最後に`chrome://extensions`でMeeting Copilot Controlsを再読み込みし、開いているMeetページも再読み込みします。

## 配布とライセンス

Meeting Copilot本体はGPL-3.0-onlyです。BlackHoleはこのリポジトリへ同梱せず、利用者がHomebrewから直接導入します。利用前に本体と各外部依存のライセンス条件を確認してください。
