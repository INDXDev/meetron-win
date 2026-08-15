# 音声ルーティング

## 完成形

| アプリ/参加者 | 入力（microphone） | 出力（speaker） |
| --- | --- | --- |
| ユーザー本人 | 物理マイク | ヘッドホン |
| GPT参加者（Meet/Zoom） | BlackHole 16ch | BlackHole 2ch |
| ChatGPT Voice | BlackHole 2ch | BlackHole 16ch（専用Chrome内で固定） |

ChatGPT Voiceの出力は専用Chrome内で`BlackHole 16ch`だけへ送ります。macOSのシステム出力は変更しないため、同じMacでは専用Chromeから直接音が出ず、通常ChromeのMeetを経由したAI音声だけをスピーカーまたはヘッドホンで聞きます。

## 1. ユーザー本人の出力を確認する

1. スピーカーまたはヘッドホンを接続する
2. macOSのシステム出力が、そのスピーカーまたはヘッドホンになっていることを確認する
3. 普段使うChromeのMeetでも、Speakerに同じ物理出力を選ぶ

バージョン0.6以前で作成した`Meeting Copilot Output`は使用しません。残しても問題ありませんが、不要ならAudio MIDI設定から削除できます。

## 2. 変更前のデバイスを保存する

`switchaudio-osx`を導入済みなら、元の設定を記録します。

```bash
SwitchAudioSource -c -t input
SwitchAudioSource -c -t output
```

`configure-audio.sh`と拡張の開始操作は、初回切り替え前のデバイス名を`.meeting-copilot-runtime/audio-original.json`へ自動保存します。

## 3. ChatGPT用の入力を設定する

拡張の初期セットアップでは`ChatGPT入力を設定`を押すと、次の切り替えを実行します。通常利用時も`開始`を押した後、ChatGPT Voiceを開く前に自動設定されます。

```bash
SwitchAudioSource -t input -s "BlackHole 2ch"
```

システム出力は変更しません。Voice開始時に専用Chromeの出力先APIを使い、ChatGPTのAudioContextと、DOM内外で生成された音声要素を`BlackHole 16ch`へ固定します。さらにChrome内部の稼働中出力を検査し、ChatGPTから内蔵スピーカーなど別デバイスへの出力が1系統でも残っていれば起動を中止します。Chrome 110以降が必要です。

## 4. GPT参加者を開く

GPT参加者の会議マイクは、経路が完成するまでミュートしておきます。

```bash
./scripts/open-gpt-participant.sh "https://meet.google.com/xxx-yyyy-zzz"
```

Google Meetでは参加前設定を自動化できます。専用Chromeがすでに起動している場合は、同じプロファイルへMeetタブを追加します。

```bash
npm install
./scripts/open-gpt-participant.sh --auto-prepare \
  "https://meet.google.com/xxx-yyyy-zzz"
```

自動設定する項目:

- 専用Chrome内でのMeetマイク権限
- 初回のマイク案内
- 表示名`GPT-Live`
- Microphone: `BlackHole 16ch`
- Speaker: `BlackHole 2ch`
- マイクとカメラをオフにした参加前状態

参加リクエストまで自動化する場合は`--join`を使います。Meet側の検証準備を待つため、初期値では参加前設定の完了後2秒待機します。事前に共通の専用ChromeプロファイルでGoogleへ一度ログインしてください。匿名状態ではGoogle側が自動ノックを拒否する場合があります。

```bash
./scripts/open-gpt-participant.sh --join \
  "https://meet.google.com/xxx-yyyy-zzz"
```

`open-gpt-participant.sh`単体では、参加リクエスト後も会議マイクはミュートのままです。主催者の承認が必要な会議では、承認されるまで待機画面になります。安定運用では、この専用GoogleアカウントをCalendarの参加者へ追加してください。

`start-meeting-copilot.sh`では、入室確認後に会議マイクを自動解除します。会議中の緊急停止や再開には次を使います。

```bash
./scripts/set-meet-mic.sh mute
./scripts/set-meet-mic.sh unmute
```

Google Meetでは参加前画面または`Settings > Audio`、Zoom Web Clientでは`Audio settings`で次を選びます。

- Microphone: `BlackHole 16ch`
- Speaker: `BlackHole 2ch`
- Camera: オフ
- Display name: `GPT-Live`

自動設定モードは、専用Chromeのメディア権限ダイアログを起動中だけ自動承認します。専用プロファイルは通常のChromeとは権限・Cookie・ログイン状態が別です。このウィンドウを会議以外の閲覧には使わないでください。

Zoomのリンクがデスクトップアプリを開こうとした場合は、ページ内の`Join from Your Browser`を選びます。Google Meetでログイン済みアカウント名が表示名として固定される場合は、専用Googleアカウントを使うか、表示名が`GPT-Live`でないことを参加者へ明示してください。

## 5. ChatGPT Voiceを開始する

自動化する場合:

```bash
./scripts/open-chatgpt-live.sh --restart-profile
```

初回だけ、Meetと共用する専用ChromeでChatGPTへログインし、コマンドを再実行します。その後は次を自動で行います。

- `Meeting Copilot` Projectを開く
- 毎回新しいチャットを作る
- ChatGPT Voice出力を`BlackHole 16ch`へ固定する
- ChatGPT Voiceを開始する

会議中のVoice再起動には常駐パネルを使います。ChatGPTタブだけを置き換え、Meetタブと参加状態を維持します。`--restart-profile`は共通Chrome全体を終了するため、Meet参加中には使わないでください。

手動で行う場合:

1. [ChatGPT Project設定](chatgpt-project.md)の`Meeting Copilot` Projectを開く
2. 新しいVoice会話を開始する
3. GPT参加者のspeakerテスト音または別参加者の発話がChatGPTへ届くことを確認する
4. ChatGPTの短い応答が通常ChromeのMeet経由で聞こえることを確認する
5. GPT参加者の入力レベルが動くことを確認してから、会議マイクをアンミュートする

ChatGPT Voiceは会議側を操作しません。会議マイクのミュートが、意図しない発話を外へ出さない最終防御です。

## 6. ループの確認

次の状態なら経路が誤っています。

- ChatGPTが自分の発話へ連続して反応する
- GPT参加者の入力メーターが、他参加者の発話だけでもChatGPT応答前から動き続ける
- 音量が反復するたびに大きくなる

発生したらGPT参加者の会議マイクを直ちにミュートし、次を確認します。

1. GPT参加者のspeakerが`BlackHole 2ch`
2. GPT参加者のmicrophoneが`BlackHole 16ch`
3. ChatGPT入力が`BlackHole 2ch`
4. ChatGPT出力が専用Chrome内で`BlackHole 16ch`へ設定されている

## 7. 終了と復元

常駐パネルの`終了・復元`は、GPT参加者のミュート、ChatGPT Voice終了、Meet退出と専用Meetタブの終了、システム入出力の復元を順に実行します。パネルを利用できない場合は次を実行します。

```bash
./scripts/set-meet-mic.sh mute
./scripts/restore-audio.sh
```

ChatGPT以外のシステム音は`BlackHole 16ch`へ流れません。同じMacでAI音声が二重に聞こえる場合は、直ちにGPT参加者をミュートして起動ログの`internalAudioOutput`を確認してください。`unexpectedOutputs`にデバイスが記録される場合、Voiceは自動終了し、開始処理全体では専用Chromeも閉じてmacOSの入力設定を復元します。

## 参考

- [Chrome Developers: Change the destination output device in Web Audio](https://developer.chrome.com/blog/audiocontext-setsinkid/)
- [Google Meet: Tips to manage your audio and video](https://support.google.com/a/users/answer/12018158)
