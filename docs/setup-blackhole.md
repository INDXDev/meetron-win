# BlackHoleセットアップ

## 目的

会議からChatGPTへ入る経路に`BlackHole 2ch`、ChatGPTから会議へ戻す経路に`BlackHole 16ch`を使います。異なるデバイスに分けることが、音声ループ防止の要点です。

## 1. 事前確認

```bash
./scripts/check-env.sh
```

このチェックはBlackHoleが未導入なら終了コード`1`を返します。診断結果に表示された不足項目を確認してください。

## 2. インストール

実行内容を先に確認します。

```bash
./scripts/install-audio-deps.sh --dry-run
```

BlackHoleのライセンス注意事項を確認してからインストールします。

```bash
./scripts/install-audio-deps.sh --accept-blackhole-license
```

スクリプトを使わない場合の同等コマンドは次のとおりです。

```bash
brew install --cask blackhole-2ch
brew install --cask blackhole-16ch
brew install switchaudio-osx
```

Homebrew Caskのpkgインストール中に、macOSの管理者パスワードを求められる場合があります。

## 3. macOSを再起動

BlackHoleのインストール完了後、macOSを再起動します。CoreAudioだけの再起動で認識する場合もありますが、PoCの再現手順はOS再起動に統一します。

## 4. 認識確認

```bash
./scripts/check-env.sh
SwitchAudioSource -a | sort -u
```

少なくとも次の2デバイスが表示されることを確認します。

```text
BlackHole 2ch
BlackHole 16ch
```

表示されない場合:

1. `/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver`と`BlackHole16ch.driver`が存在するか確認する
2. macOSを再起動する
3. `brew reinstall --cask blackhole-2ch blackhole-16ch`を実行して再起動する
4. それでも認識しなければBlackHole公式のインストールトラブルシューティングを確認する

## ライセンス境界

このプロジェクトはBlackHoleをダウンロード、複製、同梱しません。Homebrewからユーザー環境へ直接導入する外部依存として扱います。

- BlackHole公式: https://github.com/ExistentialAudio/BlackHole
- BlackHole LICENSE: https://github.com/ExistentialAudio/BlackHole/blob/master/LICENSE
- Homebrew Cask: https://formulae.brew.sh/cask/blackhole-2ch

BlackHole公式READMEは、非GPLv3プロジェクトにはライセンスが必要と案内しています。OSS公開時にも依存の扱いを再確認し、商用利用や同梱配布の前には必ずライセンスレビューを行ってください。
