const SERVICE_UUID = '9f8d0001-6b7b-4f26-b10f-3aa861aa0001';
const AUDIO_CHAR_UUID = '9f8d0002-6b7b-4f26-b10f-3aa861aa0001';
const BATT_CHAR_UUID = '9f8d0003-6b7b-4f26-b10f-3aa861aa0001';
const STATE_CHAR_UUID = '9f8d0004-6b7b-4f26-b10f-3aa861aa0001';

const AUDIO_CODEC_PCM16 = 0;
const AUDIO_CODEC_IMA_ADPCM = 1;
const FRAME_MS = 20;
const TARGET_BUFFER_FRAMES = 4;
const MAX_BUFFER_FRAMES = 24;
const MAX_CONCEAL_FRAMES_PER_GAP = 8;

const ADPCM_INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const ADPCM_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19,
  21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55,
  60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157,
  173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
  494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
  1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660,
  4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];

const connectBtn = document.getElementById('connectBtn');
const flashBtn = document.getElementById('flashBtn');
const connState = document.getElementById('connState');
const gateState = document.getElementById('gateState');
const battery = document.getElementById('battery');
const firmwareUrlInput = document.getElementById('firmwareUrl');
const firmwareFileInput = document.getElementById('firmwareFile');
const flashAddressInput = document.getElementById('flashAddress');
const eraseAllInput = document.getElementById('eraseAll');
const flashProgress = document.getElementById('flashProgress');
const flashStatus = document.getElementById('flashStatus');
const frameCountEl = document.getElementById('frameCount');
const dropCountEl = document.getElementById('dropCount');
const mutedCountEl = document.getElementById('mutedCount');
const concealedCountEl = document.getElementById('concealedCount');
const bufferDepthEl = document.getElementById('bufferDepth');
const logs = document.getElementById('logs');

let audioContext;
let scheduleAt = 0;
let bleDevice = null;
let reconnectTimer = null;
let lastSeq = null;
let disconnectBound = false;
let isConnecting = false;
let jitterTimer = null;
let expectedSeq = null;
let playoutStarted = false;
let streamSampleRate = 8000;
let streamSampleCount = 160;
let lastGoodFrame = null;
let lastAudioFrameAt = 0;
let noAudioTimer = null;

const jitterQueue = [];

const ESPTOOL_IMPORT_URLS = [
  'https://esm.sh/esptool-js@0.5.6?bundle',
  'https://esm.sh/esptool-js@0.5.6',
  'https://cdn.skypack.dev/esptool-js@0.5.6',
];
const DEFAULT_FIRMWARE_URL = './firmware/tosstalk-merged.bin';

let esptoolModule = null;

const stats = {
  frames: 0,
  drops: 0,
  mutedFrames: 0,
  concealedFrames: 0,
  truncatedFrames: 0,
};

function updateStatsUi() {
  frameCountEl.textContent = String(stats.frames);
  dropCountEl.textContent = String(stats.drops);
  mutedCountEl.textContent = String(stats.mutedFrames);
  concealedCountEl.textContent = String(stats.concealedFrames);
  bufferDepthEl.textContent = String(jitterQueue.length);
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  logs.textContent = `[${time}] ${message}\n` + logs.textContent;
}

function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function clearNoAudioMonitor() {
  if (noAudioTimer) {
    clearInterval(noAudioTimer);
    noAudioTimer = null;
  }
}

function startNoAudioMonitor() {
  clearNoAudioMonitor();
  lastAudioFrameAt = Date.now();
  noAudioTimer = setInterval(() => {
    const elapsed = Date.now() - lastAudioFrameAt;
    if (elapsed > 6000) {
      log('No audio frames received for 6s. If BLE is connected, this is likely a notification/MTU issue.');
      lastAudioFrameAt = Date.now();
    }
  }, 2000);
}

function setFlashStatus(text) {
  flashStatus.textContent = text;
  log(`FLASH: ${text}`);
}

function formatError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err?.message) return String(err.message);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function parseAddress(value) {
  const input = value.trim().toLowerCase();
  if (input.startsWith('0x')) return Number.parseInt(input.slice(2), 16);
  return Number.parseInt(input, 10);
}

function padTo4Bytes(u8) {
  const rem = u8.length % 4;
  if (rem === 0) return u8;
  const out = new Uint8Array(u8.length + (4 - rem));
  out.set(u8);
  return out;
}

async function loadEsptoolModule() {
  if (esptoolModule) return esptoolModule;

  let lastError = null;
  for (const url of ESPTOOL_IMPORT_URLS) {
    try {
      esptoolModule = await import(url);
      return esptoolModule;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Unable to load esptool-js module: ${lastError?.message || 'unknown error'}`);
}

async function loadFirmwareImage() {
  const chosenFile = firmwareFileInput.files?.[0];
  const firmwareUrl = (firmwareUrlInput.value.trim() || DEFAULT_FIRMWARE_URL);

  if (chosenFile) {
    const arrayBuffer = await chosenFile.arrayBuffer();
    return {
      name: chosenFile.name,
      data: new Uint8Array(arrayBuffer),
    };
  }

  const response = await fetch(firmwareUrl, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to fetch firmware URL (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    name: firmwareUrl,
    data: new Uint8Array(arrayBuffer),
  };
}

function gateName(v) {
  switch (v) {
    case 0:
      return 'UnmutedLive';
    case 1:
      return 'AirborneSuppressed';
    case 2:
      return 'ImpactLockout';
    case 3:
      return 'Reacquire';
    default:
      return `Unknown(${v})`;
  }
}

function getBluetoothUnavailableMessage() {
  const reasons = [];

  if (!window.isSecureContext) {
    reasons.push('This page is not running in a secure context (HTTPS required).');
  }

  if (!('bluetooth' in navigator)) {
    reasons.push('Web Bluetooth API is not available in this browser build.');
  }

  return [
    'Bluetooth connection is unavailable on this browser.',
    ...reasons,
    '',
    'Try one of these:',
    '- Use Google Chrome or Microsoft Edge desktop',
    '- Ensure Linux Bluetooth is enabled and working',
    '- Open this app over HTTPS (or localhost for local testing)',
  ].join('\n');
}

function ensureAudio() {
  if (!audioContext) {
    audioContext = new AudioContext({ sampleRate: 48000 });
    scheduleAt = audioContext.currentTime;
  }
}

function playPcm16(sampleRate, pcmBytes) {
  ensureAudio();

  const int16 = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 2);
  const floatData = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    floatData[i] = int16[i] / 32768;
  }

  const buffer = audioContext.createBuffer(1, floatData.length, sampleRate);
  buffer.copyToChannel(floatData, 0);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);

  const now = audioContext.currentTime;
  scheduleAt = Math.max(scheduleAt, now + 0.02);
  source.start(scheduleAt);
  scheduleAt += buffer.duration;
}

function playPcm16Samples(sampleRate, int16) {
  ensureAudio();

  const floatData = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    floatData[i] = int16[i] / 32768;
  }

  const buffer = audioContext.createBuffer(1, floatData.length, sampleRate);
  buffer.copyToChannel(floatData, 0);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);

  const now = audioContext.currentTime;
  scheduleAt = Math.max(scheduleAt, now + 0.02);
  source.start(scheduleAt);
  scheduleAt += buffer.duration;
}

function resetAudioPipeline() {
  jitterQueue.length = 0;
  expectedSeq = null;
  playoutStarted = false;
  lastGoodFrame = null;
  updateStatsUi();
}

function makeConcealmentFrame(sampleCount) {
  const out = new Int16Array(sampleCount);
  if (!lastGoodFrame || lastGoodFrame.length !== sampleCount) {
    return out;
  }

  for (let i = 0; i < sampleCount; i++) {
    out[i] = (lastGoodFrame[i] * 7) >> 3;
  }
  return out;
}

function enqueueFrame(sampleRate, sampleCount, frame) {
  streamSampleRate = sampleRate;
  streamSampleCount = sampleCount;

  if (jitterQueue.length >= MAX_BUFFER_FRAMES) {
    jitterQueue.shift();
    stats.drops += 1;
  }

  jitterQueue.push(frame);
  updateStatsUi();
}

function ensurePlayoutLoop() {
  if (jitterTimer) return;

  jitterTimer = setInterval(() => {
    ensureAudio();

    if (!playoutStarted) {
      if (jitterQueue.length < TARGET_BUFFER_FRAMES) {
        return;
      }
      playoutStarted = true;
      scheduleAt = Math.max(scheduleAt, audioContext.currentTime + 0.04);
    }

    let frame = jitterQueue.shift();
    if (!frame) {
      frame = makeConcealmentFrame(streamSampleCount);
      stats.concealedFrames += 1;
    }

    playPcm16Samples(streamSampleRate, frame);
    updateStatsUi();
  }, FRAME_MS);
}

function decodeImaAdpcm(data, sampleCount, predictor, index) {
  const out = new Int16Array(sampleCount);
  let pred = predictor;
  let idx = Math.min(88, Math.max(0, index));
  let o = 0;

  for (let i = 0; i < data.length && o < sampleCount; i++) {
    const byte = data[i];
    const n0 = byte & 0x0f;
    const n1 = (byte >> 4) & 0x0f;

    for (const nibble of [n0, n1]) {
      let step = ADPCM_STEP_TABLE[idx];
      let diff = step >> 3;
      if (nibble & 0x01) diff += step >> 2;
      if (nibble & 0x02) diff += step >> 1;
      if (nibble & 0x04) diff += step;

      if (nibble & 0x08) pred -= diff;
      else pred += diff;

      pred = Math.max(-32768, Math.min(32767, pred));
      idx += ADPCM_INDEX_TABLE[nibble];
      idx = Math.max(0, Math.min(88, idx));

      out[o++] = pred;
      if (o >= sampleCount) break;
    }
  }

  return out;
}

function handleAudioFrame(event) {
  const dv = event.target.value;
  if (!dv || dv.byteLength < 8) return;

  const seq = dv.getUint16(0, true);
  const sampleRate = dv.getUint16(2, true);
  const sampleCount = dv.getUint8(4);
  const flags = dv.getUint8(5);
  const codec = dv.getUint8(6);
  const payload = new Uint8Array(dv.buffer, dv.byteOffset + 8, dv.byteLength - 8);
  lastAudioFrameAt = Date.now();

  ensurePlayoutLoop();

  if (lastSeq !== null) {
    const delta = (seq - lastSeq + 65536) % 65536;
    if (delta > 1) {
      stats.drops += delta - 1;
    }
  }
  lastSeq = seq;
  stats.frames += 1;

  if (expectedSeq === null) {
    expectedSeq = seq;
  }

  const seqGap = (seq - expectedSeq + 65536) % 65536;
  if (seqGap > 0 && seqGap < 1000) {
    const conceal = Math.min(seqGap, MAX_CONCEAL_FRAMES_PER_GAP);
    for (let i = 0; i < conceal; i++) {
      enqueueFrame(sampleRate, sampleCount, makeConcealmentFrame(sampleCount));
      stats.concealedFrames += 1;
    }
  }
  expectedSeq = (seq + 1) & 0xffff;

  if (flags & 0x01) {
    stats.mutedFrames += 1;
    enqueueFrame(sampleRate, sampleCount, new Int16Array(sampleCount));
    updateStatsUi();
    return;
  }

  if (codec === AUDIO_CODEC_IMA_ADPCM) {
    const expectedBytes = 8 + 4 + Math.floor(sampleCount / 2);
    if (dv.byteLength < expectedBytes) {
      stats.truncatedFrames += 1;
      if (stats.truncatedFrames % 20 === 1) {
        log(`Audio frame appears truncated (${dv.byteLength} bytes, expected ~${expectedBytes})`);
      }
    }

    if (payload.byteLength >= 4) {
      const headerOffset = dv.byteOffset + 8;
      const predictor = dv.getInt16(8, true);
      const index = dv.getUint8(10);
      const adpcm = new Uint8Array(dv.buffer, headerOffset + 4, dv.byteLength - 12);
      const pcm = decodeImaAdpcm(adpcm, sampleCount, predictor, index);
      lastGoodFrame = pcm;
      enqueueFrame(sampleRate, sampleCount, pcm);
    }
  } else if (codec === AUDIO_CODEC_PCM16 && payload.byteLength >= sampleCount * 2) {
    const pcm = new Int16Array(payload.buffer, payload.byteOffset, sampleCount);
    const cloned = new Int16Array(sampleCount);
    cloned.set(pcm);
    lastGoodFrame = cloned;
    enqueueFrame(sampleRate, sampleCount, cloned);
  } else {
    enqueueFrame(sampleRate, sampleCount, makeConcealmentFrame(sampleCount));
    stats.concealedFrames += 1;
  }

  updateStatsUi();

  if (seq % 50 === 0) {
    log(`Audio seq=${seq} sr=${sampleRate} samples=${sampleCount}`);
  }
}

function handleBattery(event) {
  const dv = event.target.value;
  if (!dv || dv.byteLength < 2) return;
  const pct = dv.getUint8(0);
  const charging = dv.getUint8(1) === 1;
  battery.textContent = `${pct}%${charging ? ' (charging)' : ''}`;
}

function handleState(event) {
  const dv = event.target.value;
  if (!dv || dv.byteLength < 1) return;
  const state = dv.getUint8(0);
  gateState.textContent = gateName(state);
}

async function connectBle() {
  if (isConnecting) {
    log('Connect already in progress');
    return;
  }

  let server = null;
  isConnecting = true;
  try {
    if (!('bluetooth' in navigator)) {
      const msg = getBluetoothUnavailableMessage();
      connState.textContent = 'Web Bluetooth unavailable';
      log(msg.replaceAll('\n', ' | '));
      alert(msg);
      return;
    }

    connState.textContent = 'Selecting device...';
    const device = bleDevice || (await withTimeout(
      navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      }),
      30000,
      'Device picker'
    ));
    bleDevice = device;
    connState.textContent = 'Connecting...';

    if (!disconnectBound) {
      device.addEventListener('gattserverdisconnected', () => {
        connState.textContent = 'Disconnected';
        log('BLE disconnected');
        resetAudioPipeline();
        clearNoAudioMonitor();
        if (!isConnecting) {
          scheduleReconnect();
        }
      });
      disconnectBound = true;
    }

    let service = null;
    let lastAttemptError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (device.gatt.connected) {
          try {
            device.gatt.disconnect();
          } catch {
            // ignore stale disconnect errors
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        connState.textContent = attempt === 1 ? 'Connecting...' : 'Reconnecting...';
        server = await withTimeout(device.gatt.connect(), 15000, 'GATT connect');
        resetAudioPipeline();

        connState.textContent = 'Resolving service...';
        try {
          service = await withTimeout(server.getPrimaryService(SERVICE_UUID), 20000, 'Primary service');
        } catch (primaryErr) {
          log(`Primary service lookup failed: ${formatError(primaryErr)}`);
          const services = await withTimeout(server.getPrimaryServices(), 12000, 'Primary services list');
          const target = SERVICE_UUID.toLowerCase();
          service = services.find((s) => String(s.uuid || '').toLowerCase() === target) || null;
          if (!service) {
            const found = services.map((s) => String(s.uuid || 'unknown')).join(', ');
            throw new Error(`Service ${SERVICE_UUID} not found. Device exposed: ${found || 'none'}`);
          }
          log('Recovered service via fallback discovery');
        }

        // success on this attempt
        lastAttemptError = null;
        break;
      } catch (attemptErr) {
        lastAttemptError = attemptErr;
        log(`Connect attempt ${attempt} failed: ${formatError(attemptErr)}`);
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
      }
    }

    if (!service) {
      throw lastAttemptError || new Error('Unable to resolve TossTalk BLE service');
    }

    connState.textContent = 'Resolving characteristics...';
    const [audioChar, battChar, stateChar] = await withTimeout(
      Promise.all([
        service.getCharacteristic(AUDIO_CHAR_UUID),
        service.getCharacteristic(BATT_CHAR_UUID),
        service.getCharacteristic(STATE_CHAR_UUID),
      ]),
      8000,
      'Characteristics'
    );

    connState.textContent = 'Starting notifications...';
    await withTimeout(battChar.startNotifications(), 7000, 'Start battery notifications');
    log('Battery notifications started');
    await withTimeout(stateChar.startNotifications(), 7000, 'Start state notifications');
    log('State notifications started');
    await withTimeout(audioChar.startNotifications(), 12000, 'Start audio notifications');
    log('Audio notifications started');

    audioChar.addEventListener('characteristicvaluechanged', handleAudioFrame);
    battChar.addEventListener('characteristicvaluechanged', handleBattery);
    stateChar.addEventListener('characteristicvaluechanged', handleState);

    try {
      const battNow = await withTimeout(battChar.readValue(), 3000, 'Read battery');
      handleBattery({ target: { value: battNow } });
    } catch (err) {
      log(`Battery read skipped: ${formatError(err)}`);
    }

    try {
      const stateNow = await withTimeout(stateChar.readValue(), 3000, 'Read state');
      handleState({ target: { value: stateNow } });
    } catch (err) {
      log(`State read skipped: ${formatError(err)}`);
    }

    clearReconnect();
    startNoAudioMonitor();
    connState.textContent = `Connected: ${device.name || 'TossTalk'}`;
    log('BLE connected and notifications active');
  } catch (err) {
    connState.textContent = 'Connect failed';
    log(`Connect failed: ${formatError(err)}`);
    try {
      if (server?.device?.gatt?.connected) {
        server.device.gatt.disconnect();
      } else if (bleDevice?.gatt?.connected) {
        bleDevice.gatt.disconnect();
      }
    } catch {
      // ignore cleanup failures
    }
    throw err;
  } finally {
    isConnecting = false;
  }
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (!bleDevice || reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      connState.textContent = 'Reconnecting...';
      await connectBle();
      log('BLE auto-reconnect success');
    } catch (err) {
      log(`BLE auto-reconnect failed: ${err.message}`);
      scheduleReconnect();
    }
  }, 1500);
}

async function startFlashFlow() {
  if (!('serial' in navigator)) {
    alert('Web Serial unavailable. Use a Chromium desktop browser.');
    return;
  }

  flashBtn.disabled = true;
  flashProgress.value = 0;

  let transport = null;
  try {
    setFlashStatus('Loading esptool-js...');
    const { ESPLoader, Transport } = await loadEsptoolModule();

    setFlashStatus('Reading firmware image...');
    const firmware = await loadFirmwareImage();
    const flashAddress = parseAddress(flashAddressInput.value);
    if (!Number.isFinite(flashAddress) || flashAddress < 0) {
      throw new Error('Invalid flash address. Use decimal or hex (for example 0x0).');
    }

    setFlashStatus('Select ESP serial port...');
    const port = await navigator.serial.requestPort({});

    const terminalAdapter = {
      clean() {
        return;
      },
      writeLine(data) {
        log(String(data));
      },
      write(data) {
        log(String(data));
      },
    };

    transport = new Transport(port, false);
    const loader = new ESPLoader({
      transport,
      baudrate: 115200,
      terminal: terminalAdapter,
      debugLogging: false,
    });

    setFlashStatus('Connecting to chip...');
    const chip = await loader.main('default_reset');
    log(`Connected to chip: ${chip}`);

    setFlashStatus('Writing firmware...');
    let image = padTo4Bytes(firmware.data);

    if (Boolean(eraseAllInput.checked) && loader.IS_STUB) {
      setFlashStatus('Erasing flash...');
      await loader.eraseFlash();
    }

    const blockSize = loader.FLASH_WRITE_SIZE || 0x4000;
    const blocks = await loader.flashBegin(image.length, flashAddress);
    let offset = 0;

    for (let seq = 0; seq < blocks; seq++) {
      const end = Math.min(offset + blockSize, image.length);
      const block = image.slice(offset, end);
      const timeout = Math.max(
        3000,
        loader.timeoutPerMb(loader.ERASE_WRITE_TIMEOUT_PER_MB, Math.max(1, block.length))
      );

      await loader.flashBlock(block, seq, timeout);
      offset = end;

      const pct = image.length > 0 ? Math.round((offset / image.length) * 100) : 100;
      flashProgress.value = pct;
      flashStatus.textContent = `Flashing ${pct}%`;
    }

    await loader.flashFinish(false);

    setFlashStatus('Finalizing and rebooting...');
    await loader.after('hard_reset');
    setFlashStatus(`Flash successful: ${firmware.name}`);
  } catch (err) {
    setFlashStatus(`Flash failed: ${formatError(err)}`);
    throw err;
  } finally {
    flashBtn.disabled = false;
    if (transport) {
      try {
        await transport.disconnect();
      } catch {
        // Ignore disconnect cleanup errors.
      }
    }
  }
}

connectBtn.addEventListener('click', () => connectBle().catch((err) => log(`Connect error: ${err.message}`)));
flashBtn.addEventListener('click', () => startFlashFlow().catch((err) => log(`Flash error: ${err.message}`)));
updateStatsUi();
if (!firmwareUrlInput.value.trim()) {
  firmwareUrlInput.value = DEFAULT_FIRMWARE_URL;
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}