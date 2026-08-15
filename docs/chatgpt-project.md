# ChatGPT Project設定

## 1. WebでChatGPT Projectを作る

現行の新しいChatGPT desktop appは、既存のChatGPT Projectsを表示してChat/Workを開始できますが、Project instructionsの編集UIが表示されない場合があります。設定はWeb版で行うのが確実です。

1. ブラウザで`https://chatgpt.com/`を開き、PCアプリと同じアカウントおよびWorkspaceでログインする
2. 左サイドバーの`New project`からProjectを作る
3. Project名を`Meeting Copilot`にする
4. Projectを開き、右上の`...`から`Project settings`を選ぶ
5. Instructionsへ、下記の指示を設定する

公式Help Centerも、Project右上の3点メニューから`Project settings`を開く手順を案内しています。

## 2. PCアプリでProjectを開く

1. ChatGPT desktop appで、左上の切り替えを`Codex`ではなく`ChatGPT`にする
2. `Projects`にWebで作成した`Meeting Copilot`が表示されることを確認する
3. Project内で`Chat`を選び、新しい会話を開始する
4. Voiceを開始する

表示されない場合は、WebとPCアプリのアカウント/Workspaceが同じか確認し、PCアプリを再起動します。

### Projectの種類に注意

- **ChatGPT Project（クラウド）**: Chat、ファイル、Project instructionsを共有する。このPoCで使う
- **Local Project（PCのフォルダ）**: Codexがローカルファイルを扱うためのProject。`Edit project`は主にフォルダ設定で、ChatGPT Project instructionsとは別物

このリポジトリをフォルダとして開いたLocal Projectにinstructions欄がないのは、現行仕様と整合します。

## 3. Project instructions

```text
あなたは「GPT-Live」という名前で会議に参加する助言者です。

会議中の発言を聞き、次の情報を内部で追跡してください。
- 現在の議題と論点
- 合意したことと未決事項
- 発言者が述べた前提、懸念、次の行動

通常は完全に沈黙してください。相づち、挨拶、確認、要約、笑い、フィラー、聞き返しを含め、自発的な音声を一切出さないでください。

次のように明示的に名前を呼ばれ、意見を求められた場合だけ発話してください。
- 「ChatGPT、どう思う？」
- 「GPT、どう思う？」
- 「GPT-Live、どう思う？」
- 「GPT、応答して」
- 「GPT-Live、応答して」

「応答して」とだけ呼ばれた場合は、直前の議題または未回答の問いに答えてください。名前が呼ばれても、意見や回答を求められていなければ沈黙を続けてください。誰に向けた発言か曖昧な場合も沈黙してください。

発話するときは30秒以内で、次の順に簡潔に答えてください。
1. 現在の論点
2. 見落とされていそうなリスクまたは前提
3. 次に取るべき具体的な提案

不確かなことを断定しないでください。必要なら「ここは確認が必要です」と短く述べてください。回答後は再び完全に沈黙してください。
```

## 4. Voice開始前の確認

- macOSのChatGPTマイク権限が許可されている
- システム入力またはChatGPT入力が`BlackHole 2ch`
- 専用Chrome内のChatGPT出力が`BlackHole 16ch`へ自動設定される
- GPT参加者の会議マイクがミュートされている
- 会議参加者へAI参加と音声処理について必要な通知を済ませている

Voiceは一度に1会話だけ開始します。デバイスを切り替えた後に音声が届かない場合は、Voice会話を終了してから開始し直してください。

## 5. 初回テストシナリオ

2人以上のテスト会議を用意し、GPT参加者のマイクをミュートしたまま次の内容を3分程度話します。

```text
議題はリリース日です。
候補Aは金曜日、候補Bは翌週火曜日です。
金曜日のリスクはQA期間が1日しかないことです。
翌週火曜日ならQA期間を確保できますが、営業デモに間に合いません。
暫定案として金曜日は社内リリース、火曜日に一般公開します。
```

その後、GPT参加者をアンミュートして次のように呼びます。

```text
GPT-Live、今の案についてどう思う？
```

期待する応答:

- 論点がリリース日の選択だと把握している
- QA期間と営業デモのトレードオフに触れる
- 社内リリースと一般公開の判定条件など、具体的な次の行動を提案する
- 30秒以内に終わる

## 6. 意図せず発話する場合

1. まず会議側でGPT参加者をミュートする
2. instructionsの冒頭へ次を追加する

```text
最優先規則: 明示的に「GPT-Live」と呼ばれ、同じ発言内で質問された場合以外は、音声を一切生成しないでください。
```

3. 新しいVoice会話で再テストする
4. それでも発話する場合、プロンプト制御だけでの運用を中止し、会議側のミュートを常時維持して発言時だけ人が解除する

Project instructionsは発話抑制の保証機構ではありません。PoCの安全側の運用は、会議側ミュートを外側のゲートとして使うことです。

## 公式情報

- [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt)
- [Projects and chats（desktop app / webの違い）](https://learn.chatgpt.com/docs/projects)
- [Moving to the new ChatGPT desktop app](https://help.openai.com/en/articles/20001276)
- [Voice Mode FAQ](https://help.openai.com/en/articles/8400625-voice-mode-faq)
- [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)

OpenAIのドキュメントでは、Projectsがinstructionsと文脈を保持し、Project内でVoice modeを利用できることが案内されています。Voiceの可用性、上限、画面構成はプランやアプリの更新で変わる可能性があります。
