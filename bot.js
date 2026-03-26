/**
 * VoiceRelay JS
 *
 * Discord bot that joins a voice channel, captures user audio,
 * transcribes speech via OpenAI Whisper, and relays the text
 * to a designated text channel.
 *
 * Usage:
 *   1. Copy .env.example to .env and fill in BOT_TOKEN, VOICE_CHANNEL_ID, TEXT_CHANNEL_ID
 *   2. npm install
 *   3. node bot.js
 */

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  EndBehaviorType,
} = require('@discordjs/voice');
const prism = require('prism-media');
const OpusDecoder = prism.opus.Decoder;
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BOT_TOKEN = process.env.BOT_TOKEN;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const TEXT_CHANNEL_ID = process.env.TEXT_CHANNEL_ID;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM

if (!BOT_TOKEN || !VOICE_CHANNEL_ID || !TEXT_CHANNEL_ID) {
  console.error('Missing required env vars: BOT_TOKEN, VOICE_CHANNEL_ID, TEXT_CHANNEL_ID');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// Per-user audio state
const userStreams = new Map();

function getUserState(userId) {
  if (!userStreams.has(userId)) {
    userStreams.set(userId, {
      pcmChunks: [],
      speaking: false,
    });
  }
  return userStreams.get(userId);
}

// Write PCM buffer to a WAV file
function writeWav(filePath, pcmBuffer) {
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);

  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);

  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcmBuffer]));
}

// Transcribe a WAV file using Whisper CLI
function transcribe(wavPath) {
  return new Promise((resolve, reject) => {
    const outputDir = path.dirname(wavPath);
    execFile(
      '/usr/local/bin/whisper',
      [wavPath, '--model', 'small', '--output_format', 'txt', '--output_dir', outputDir],
      { timeout: 60000 },
      (err, stdout, stderr) => {
        if (err) {
          console.error('[transcribe] Whisper error:', err.message);
          return resolve(null);
        }

        const baseName = path.basename(wavPath, '.wav');
        const txtPath = path.join(outputDir, `${baseName}.txt`);

        try {
          const text = fs.readFileSync(txtPath, 'utf-8').trim();
          try { fs.unlinkSync(wavPath); } catch {}
          try { fs.unlinkSync(txtPath); } catch {}
          resolve(text || null);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

// Flush a user's buffered audio, transcribe, and post to text channel
async function flushUser(userId, receiver) {
  const state = getUserState(userId);
  if (state.pcmChunks.length === 0) {
    if (receiver) subscribeToUser(receiver, userId);
    return;
  }

  const pcmBuffer = Buffer.concat(state.pcmChunks);
  state.pcmChunks = [];
  state.speaking = false;

  const durationSec = pcmBuffer.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);
  if (durationSec < 0.1) {
    console.log(`[flush] User ${userId} — ${durationSec.toFixed(2)}s audio too short, skipping`);
    if (receiver) subscribeToUser(receiver, userId);
    return;
  }

  const tmpFile = path.join(os.tmpdir(), `vr_${userId}_${Date.now()}.wav`);
  writeWav(tmpFile, pcmBuffer);

  console.log(`[transcribe] User ${userId} — ${durationSec.toFixed(1)}s audio`);

  const text = await transcribe(tmpFile);

  if (receiver) subscribeToUser(receiver, userId);

  if (!text) return;

  const textChannel = client.channels.cache.get(TEXT_CHANNEL_ID);
  if (!textChannel) return;

  let username = userId;
  try {
    const guild = textChannel.guild;
    const member = await guild.members.fetch(userId);
    username = member.displayName;
  } catch {}

  try {
    await textChannel.send(`\uD83C\uDF99\uFE0F **${username}**: ${text}\n<@1466498202705330375>`);
  } catch (err) {
    console.error('[error] Failed to send message:', err.message);
  }
}

// Subscribe to a user's audio stream from the voice receiver
function subscribeToUser(receiver, userId) {
  const state = getUserState(userId);

  if (state.subscribed) return;

  state.subscribed = true;
  state.pcmChunks = [];

  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
  });

  const decoder = new OpusDecoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });

  opusStream.pipe(decoder);

  decoder.on('data', (chunk) => {
    state.pcmChunks.push(chunk);
    state.speaking = true;
  });

  opusStream.on('end', () => {
    state.subscribed = false;
    try { decoder.end(); } catch {}
    flushUser(userId, receiver);
    setTimeout(() => subscribeToUser(receiver, userId), 250);
  });

  opusStream.on('error', (err) => {
    console.error(`[error] Opus stream error for ${userId}:`, err.message);
    state.subscribed = false;
    setTimeout(() => subscribeToUser(receiver, userId), 250);
  });

  opusStream.on('close', () => {
    // Stream closed, no action needed
  });
}

// Join the voice channel and set up audio receivers
function connectToVoice(channel) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  connection.on(VoiceConnectionStatus.Signalling, () => {
    console.log('[voice] Status: Signalling');
  });

  connection.on(VoiceConnectionStatus.Connecting, () => {
    console.log('[voice] Status: Connecting');
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    console.log('[voice] Status: Destroyed');
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.log('[voice] Disconnected — attempting reconnect...');
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      console.log('[voice] Reconnect failed — rejoining...');
      connection.destroy();
      setTimeout(() => connectToVoice(channel), 3000);
    }
  });

  connection.on(VoiceConnectionStatus.Ready, () => {
    console.log('[voice] Connected and ready');
    const receiver = connection.receiver;

    receiver.speaking.on('start', (userId) => {
      console.log(`[speaking] User ${userId} started speaking`);
      if (userId === client.user.id) return;
      subscribeToUser(receiver, userId);
    });

    receiver.speaking.on('end', (userId) => {
      console.log(`[speaking] User ${userId} stopped speaking`);
    });

    // Subscribe to members already in the channel
    channel.members.forEach((member) => {
      if (member.id === client.user.id) return;
      if (!member.user.bot) {
        subscribeToUser(receiver, member.id);
      }
    });
  });

  connection.on('error', (err) => {
    console.error('[error] Voice connection error:', err.message);
  });

  return connection;
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
  if (!channel || !channel.isVoiceBased()) {
    console.error(`Channel ${VOICE_CHANNEL_ID} is not a voice channel`);
    process.exit(1);
  }

  console.log(`[startup] Joining voice channel: ${channel.name}`);
  connectToVoice(channel);
});

client.login(BOT_TOKEN);
