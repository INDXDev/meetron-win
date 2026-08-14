# 音声ルーティング

## 完成形

| アプリ/参加者 | 入力（microphone） | 出力（speaker） |
| --- | --- | --- |
| ユーザー本人 | 物理マイク | ヘッドホン |
| GPT参加者（Meet/Zoom） | BlackHole 16ch | BlackHole 2ch |
| ChatGPT Voice | BlackHole 2ch | Meeting Copilot Output |

`Meeting Copilot Output`は、ヘッドホンと`BlackHole 16ch`を束ねたMulti-Output Deviceです。ここには`BlackHole 2ch`を絶対に含めないでください。

## 1. Multi-Output Deviceを作る

1. ヘッドホンを接続する。PoCでは有線またはUSBヘッドホンを推奨する
2. `/Applications/Utilities/Audio MIDI Setup.app`を開く
3. 左下の`+`から`Create Multi-Output Device`を選ぶ
4. 名前を`Meeting Copilot Output`へ変更する
5. 使用デバイスとしてヘッドホンと`BlackHole 16ch`だけを選ぶ
6. `Primary Device`で2chの物理出力を選ぶ
7. Primary Deviceではないデバイス側に`Drift Correction`が表示される場合は有効にする
8. サンプルレートは、選択できる場合は両方を`48.0 kHz`へそろえる

AirPodsなどBluetooth機器はクロックやサンプルレートの都合でMulti-Outputが不安定になる場合があります。音切れや無音が出るときは、まず有線/USBヘッドホンで経路を確立してください。

## 2. 変更前のデバイスを保存する

`switchaudio-osx`を導入済みなら、元の設定を記録します。

```bash
SwitchAudioSource -c -t input
SwitchAudioSource -c -t output
```

`configure-audio.sh`と拡張の開始操作は、初回切り替え前のデバイス名を`.meeting-copilot-runtime/audio-original.json`へ自動保存します。

## 3. ChatGPT用のシステム音声を設定する

拡張の初期セットアップでは`音声経路を設定`を押すと、次の切り替えを実行します。通常利用時も`開始`を押した後、ChatGPT Voiceを開く前に自動設定されます。

```bash
SwitchAudioSource -t input -s "BlackHole 2ch"
SwitchAudioSource -t output -s "Meeting Copilot Output"
```

ChatGPT Web Voiceは、Voice開始時のシステム既定デバイスを使います。切り替え後にすでにVoiceが動いている場合は、Voice会話を終了して開始し直します。

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
- ChatGPT Voiceを開始する

会議中のVoice再起動には常駐パネルを使います。ChatGPTタブだけを置き換え、Meetタブと参加状態を維持します。`--restart-profile`は共通Chrome全体を終了するため、Meet参加中には使わないでください。

手動で行う場合:

1. [ChatGPT Project設定](chatgpt-project.md)の`Meeting Copilot` Projectを開く
2. 新しいVoice会話を開始する
3. GPT参加者のspeakerテスト音または別参加者の発話がChatGPTへ届くことを確認する
4. ChatGPTの短い応答がヘッドホンで聞こえることを確認する
5. GPT参加者の入力レベルが動くことを確認してから、会議マイクをアンミュートする

ChatGPT Voiceは会議側を操作しません。会議マイクのミュートが、意図しない発話を外へ出さない最終防御です。

## 6. ループの確認

次の状態なら経路が誤っています。

- ChatGPTが自分の発話へ連続して反応する
- GPT参加者の入力メーターが、他参加者の発話だけでもChatGPT応答前から動き続ける
- 音量が反復するたびに大きくなる

発生したらGPT参加者の会議マイクを直ちにミュートし、次を確認します。

1. `Meeting Copilot Output`に`BlackHole 2ch`が含まれていない
2. GPT参加者のspeakerが`BlackHole 2ch`
3. GPT参加者のmicrophoneが`BlackHole 16ch`
4. ChatGPT入力が`BlackHole 2ch`
5. ChatGPT出力が`Meeting Copilot Output`

## 7. 終了と復元

常駐パネルの`終了・復元`は、GPT参加者のミュート、ChatGPT Voice終了、システム入出力の復元を順に実行します。その後、GPT参加者をMeetから退室させます。パネルを利用できない場合は次を実行します。

```bash
./scripts/set-meet-mic.sh mute
./scripts/restore-audio.sh
```

Multi-Output Deviceをシステム出力にしている間は、ChatGPT以外のシステム音も`BlackHole 16ch`へ流れます。通知音などを会議へ出したくない場合は、集中モードを有効にしてください。

## 参考

- [Apple: Play audio through multiple devices at once in Audio MIDI Setup on Mac](https://support.apple.com/guide/audio-midi-setup/ams7c093f372/mac)
- [Google Meet: Tips to manage your audio and video](https://support.google.com/a/users/answer/12018158)
- [BlackHole: Multi Output Device](https://github.com/ExistentialAudio/BlackHole/wiki/Multi-Output-Device)
