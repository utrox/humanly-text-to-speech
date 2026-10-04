# Privacy

Humanly Text to Speech doesn't collect, store or send any personal data. It has no analytics, no accounts and
no servers of its own.

**What stays on your computer**

- The text of pages and PDFs you read. Speech is generated locally, by the helper app on your
  computer or inside Firefox.
- Your settings (voice, speed and so on), kept in Firefox's extension storage.

**Network requests the add-on makes**

- **Voice model, once.** The in-Firefox voice downloads the Kokoro model from Hugging Face
  (huggingface.co) the first time you use it. The helper installer downloads it from GitHub
  (github.com). After that, both work offline.
- **PDFs you open.** When you open a PDF link, the viewer downloads that PDF from the site that hosts
  it, with your normal cookies for that site, just as Firefox's own viewer would.

**Permissions and why they're needed**

| Permission | Used for |
| --- | --- |
| Access to all websites | Reading any page you choose, and downloading PDFs you open |
| webRequest, webRequestBlocking | Opening PDF links in the reader's viewer instead of Firefox's |
| tabs, activeTab | Starting the reader in the current tab |
| contextMenus | "Read aloud from here" and "Open a PDF file in the reader…" |
| storage, unlimitedStorage | Settings and the cached voice model |
| nativeMessaging | Talking to the optional helper app on your computer |
