# Call Transcription for Sangoma Phone

A plugin for the unofficial Sangoma Phone builds that have a **Plugins** page (☰ / tray / Sangoma Phone
menu → Plugins). It adds **Transcripts** to the app's top bar, after Chat: a live transcript of each call with both sides
labelled, and the transcripts of earlier calls. Speech-to-text is done by a Whisper server you run
yourself; no audio goes anywhere else.

Transcribing records what both people say. Tell the people you talk to where the law or your company
requires it. The plugin is off until you switch it on, and Transcripts shows a red dot
while a call is being transcribed.

## Install

Put this folder into the app's plugins folder under the name `transcription`, then switch it on under
Plugins → Manage Plugins…

```sh
# Linux
git clone https://github.com/BocajBot/sangoma-phone-transcription "$HOME/.config/Sangoma Phone/plugins/transcription"
# Mac
git clone https://github.com/BocajBot/sangoma-phone-transcription "$HOME/Library/Application Support/Sangoma Phone/plugins/transcription"
```

To update: `git pull` in that folder, then switch the plugin off and on (or restart the app).

## Settings (Plugins → Manage Plugins…)

| Setting | Meaning |
| --- | --- |
| Speech-to-text server, Endpoint | Where the Whisper server listens, e.g. `http://192.168.1.20:8790` and `/transcribe` |
| How the server takes audio | A WAV file as the request body, or OpenAI style (`/v1/audio/transcriptions`) |
| Secret header name, Secret | Sent with every request if the server wants one (default header: `x-local-secret`) |
| Switch to Transcripts when a call starts | Off by default, so the call screen stays in front |
| Save transcripts on this computer | On: one JSON file per call in the folder you choose. Off: kept in memory until the app closes |
| Memory transcripts may use | Only when not saving: a share of this computer's memory, 85% at most. When it is full, the oldest conversations are dropped (the window says how many) |

## The Whisper server

Any server that answers a posted WAV with `{"text": "..."}` works. One is included, built for short
utterances arriving in a row (model kept loaded, greedy decoding):

```sh
uv run server/asr_server.py --host 0.0.0.0 --port 8790 --secret "$(openssl rand -hex 24)"
```

`--model large-v3-turbo` on a GPU is the default; on a machine without one try
`--model small.en --device cpu --compute-type int8`. `--host 0.0.0.0` serves your whole network:
always set `--secret` then, and give coworkers the address and the secret for their plugin settings.

## How it works

The app hands the plugin both directions of a call as 16 kHz audio. `lib/segmenter.js` cuts each
direction into utterances at pauses (or after 12 s), each utterance is posted to the server, and the
text is added to the conversation a moment after it was said. `lib/store.js` keeps conversations in
memory or in the folder.

Tests: `node --test tests/*.test.js`
