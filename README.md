# VoiceRelay JS

Discord bot that joins a voice channel, records all users' audio, transcribes speech using Whisper, and posts transcriptions to a text channel.

## Prerequisites

- Node.js 18+
- [Whisper CLI](https://github.com/openai/whisper) installed at `/usr/local/bin/whisper`
- FFmpeg installed
- A Discord bot with these privileged intents enabled: **Server Members**, **Message Content** (optional), and **Voice**

## Setup

```bash
cp .env.example .env
# Fill in your values in .env

npm install
npm start
```

## Environment Variables

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Discord bot token |
| `VOICE_CHANNEL_ID` | ID of the voice channel to join |
| `TEXT_CHANNEL_ID` | ID of the text channel for transcriptions |

## How It Works

1. Bot joins the configured voice channel on startup
2. Subscribes to each user's opus audio stream via `VoiceReceiver`
3. Decodes opus to PCM using `@discordjs/opus`
4. Buffers PCM per user; detects 1.5s of silence to end an utterance
5. Writes PCM to a temporary WAV file
6. Runs `whisper <file.wav> --model small --output_format txt` to transcribe
7. Posts the result to the text channel as `🎙️ [username]: transcribed text`
8. Auto-reconnects if disconnected from voice
